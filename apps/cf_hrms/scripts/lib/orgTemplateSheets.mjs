/**
 * The CF_HRMS organisation workbook: sheet layout, formulas, drop-downs, styling.
 *
 * ONE PURE MODULE. Plain data in, an ExcelJS workbook out. It never touches the
 * database or the disk (scripts/org-template.mjs does both), so the layout can
 * be tested on its own and the reader that later consumes these workbooks can
 * import the same constants and the same outline rule (readOutline below).
 *
 * THE THREE RULES THE LAYOUT EXISTS TO SERVE. Measured on the real Karni chart:
 * 114 positions, 9 levels once the machine boxes are drawn in, 12 titles used by
 * more than one seat, ten different seats all called "Helper 1".
 *
 *   1. HIERARCHY IS INDENTATION, NEVER A "REPORTS TO" COLUMN. A seat's title sits
 *      in exactly one of the columns Level 1 .. Level 10. Its parent is the
 *      nearest row above whose title sits one column to its left, with no
 *      shallower row in between. Nobody types a manager's name, so ten seats
 *      called "Helper 1" are ambiguous to nobody: position in the outline decides
 *      the parent.
 *   2. A HUMAN NEVER TYPES AN ID. Structure!A ("Ref": P001, P002 ...) is a formula
 *      on the row number. Every other sheet names a seat by picking "Ref - Title"
 *      from a drop-down that is built from Structure by formula.
 *   3. ONE ROW IS ONE SEAT, NOT ONE PERSON. "How many people?" is a number on the
 *      row; named people live on People.
 *
 * WHY EVERY FORMULA ON `Lists` READS STRUCTURE THROUGH INDEX(col, ROW()). A plain
 * reference such as =Structure!A7 follows the cell: delete Structure rows 2-5
 * (the grey examples - the very first thing every user does) and the Lists rows
 * that pointed at them turn into #REF! while the rest slide out of line.
 * INDEX(Structure!$A:$A, ROW()) names the row by number and survives both.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: protect or lock any WORKING sheet (a locked
 * sheet is the fastest way to make someone give up; the one protected sheet is
 * `Start here`, for its hidden provenance rows), or define a name that needs
 * a formula (ExcelJS only writes names that point at plain ranges, so the one
 * dynamic drop-down carries its OFFSET inline).
 *
 * A NOTE ON THE EM DASH. Seat labels read "P012 — Title" (U+2014, typed literally
 * in this file). Do not "tidy" it to a hyphen in one place: the formulas on Lists
 * build the same text, and a label stored on People must equal it exactly.
 *
 * THE ROUND TRIP (schema version 2). Ref is POSITIONAL: insert a row near the top
 * and every Ref below it changes meaning, and ten seats are called "Helper 1", so
 * neither Ref nor title can say WHICH database record a row is once the sheet has
 * been edited. So the last column of each editable sheet is a hidden KEY holding
 * the record's database id, prefixed by kind (`pos:1234`, `asg:17`, `rsp:80:301`,
 * `wct:9`, `opn:4`). A row with a key is that record; a row with no key is new; a
 * key that appears twice is a copy-pasted row, and only its first occurrence keeps
 * the identity. The key column is hidden and muted but NOT protected: Excel will
 * not let anyone delete a row that contains a locked cell on a protected sheet, and
 * deleting rows is exactly what this workbook must allow.
 *
 * A pre-filled workbook also carries PROVENANCE (company, database, time, schema
 * version, a fingerprint of what it showed) in locked, hidden rows at the foot of
 * `Start here`, so that it can never be applied to the wrong tenant or database.
 * A blank template has no provenance and every row in it is new.
 */
import crypto from 'crypto';
import ExcelJS from 'exceljs';

// --------------------------------------------------------------- contract ----
export const SHEET = Object.freeze({
  start: 'Start here',
  structure: 'Structure',
  people: 'People',
  responsibilities: 'Responsibilities',
  machines: 'Machines & areas',
  questions: 'Questions & doubts',
  lists: 'Lists',
});
export const SHEET_ORDER = Object.freeze(Object.values(SHEET));

export const LEVELS = 10;
const LEVEL_NAMES = Array.from({ length: LEVELS }, (_, i) => `Level ${i + 1}`);

/** The hidden last column of every editable sheet: the stable identity of the row's database record. */
export const KEY_HEADER = 'Key — do not edit';
/** Bumped whenever the layout changes in a way a reader must know about. 1 was the layout before keys existed. */
export const SCHEMA_VERSION = 2;

/** Header text is part of the contract: a reader finds its columns by these strings. The key column is always LAST. */
export const HEADERS = Object.freeze({
  structure: ['Ref', ...LEVEL_NAMES, 'How many people?', 'Shift', 'Department', 'Location', 'Machines or areas', 'Notes', KEY_HEADER],
  people: ['Full name', 'Seat', 'Shift', 'Employee code (optional)', 'Joined (optional)', KEY_HEADER],
  responsibilities: ['Seat', 'Responsibility', KEY_HEADER],
  machines: ['Name', 'Kind', 'Where (optional)', KEY_HEADER],
  questions: ['About (optional)', 'The question', KEY_HEADER],
});

/** Structure's columns, 1-based. */
export const COL = Object.freeze({
  ref: 1,
  firstLevel: 2,
  lastLevel: 1 + LEVELS,
  count: 2 + LEVELS,
  shift: 3 + LEVELS,
  department: 4 + LEVELS,
  location: 5 + LEVELS,
  machines: 6 + LEVELS,
  notes: 7 + LEVELS,
  key: 8 + LEVELS,
});

/** The key column of each editable sheet, 1-based (always the last heading). */
export const KEY_COLUMN = Object.freeze(Object.fromEntries(Object.entries(HEADERS).map(([sheet, headings]) => [sheet, headings.length])));

/**
 * What a key looks like on each sheet. The prefix says what KIND of record it is, so a key pasted onto the wrong
 * sheet can never be mistaken for a valid one.
 *   pos:<hrms_positions.id>                       a seat
 *   asg:<hrms_work_assignments.id>                a person in a seat (not emp: - one person can sit in two seats,
 *                                                 and two rows must not share a key)
 *   rsp:<role id>:<responsibility definition id>  a duty of a ROLE (several seats share a role)
 *   ovr:<hrms_position_content_overrides.id>      a duty added to ONE seat
 *   wct:<hrms_work_contexts.id>                   a machine or area
 *   opn:<hrms_open_points.id>                     a question
 */
export const KEY_KINDS = Object.freeze({
  structure: Object.freeze(['pos']),
  people: Object.freeze(['asg']),
  responsibilities: Object.freeze(['rsp', 'ovr']),
  machines: Object.freeze(['wct']),
  questions: Object.freeze(['opn']),
});
const KEY_SHAPE = /^(pos|asg|ovr|wct|opn):(\d+)$|^(rsp):(\d+):(\d+)$/;
/** @returns {null|{kind:string, ids:number[]}} null when the text is not a well-formed key */
export function parseKey(text) {
  const m = KEY_SHAPE.exec(String(text ?? '').trim().toLowerCase());
  if (!m) return null;
  return m[1] ? { kind: m[1], ids: [Number(m[2])] } : { kind: m[3], ids: [Number(m[4]), Number(m[5])] };
}

/** Provenance lives in hidden rows at the foot of `Start here`: column B names the field, column C holds it. */
export const PROVENANCE_PREFIX = 'provenance.';
export const PROVENANCE_FIELDS = Object.freeze(['schemaVersion', 'companySlug', 'companyId', 'target', 'targetName', 'exportedAt', 'contentHash', 'counts']);

export const KINDS = Object.freeze(['Machine', 'Line', 'Area', 'Project', 'Cell', 'Other']);
export const DAY_AND_NIGHT = 'Day & night';
export const DEFAULT_SHIFTS = Object.freeze(['General', 'Day', 'Night']);

/** A row is an example if ANY of its cells starts with this. A reader should skip such rows. */
export const EXAMPLE_MARK = 'Example:';

/** Where the hidden `Lists` sheet keeps each thing (column letters). */
const LISTS = Object.freeze({
  shiftSeat: 'A', shiftPerson: 'B', kind: 'C',
  label: 'E', count: 'F', level: 'G', lastLevel: 'H', check: 'I', index: 'J', list: 'K',
});

/** The defined names the formulas and rules lean on. Plain ranges only. */
export const NAMES = Object.freeze({
  seatShifts: 'ShiftOptions',
  personShifts: 'PersonShiftOptions',
  kinds: 'KindOptions',
  seatLabels: 'SeatLabels',
  rowCheck: 'RowCheck',
  machines: 'MachineNames',
});

// ---------------------------------------------------------------- helpers ----
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : '');

/**
 * A fingerprint of everything a workbook built from `data` shows: every row of every sheet, in order, with its key.
 * Computed when the workbook is exported and again, from the live database, when it is applied. If the two differ,
 * the database has moved since the workbook was made, and applying the workbook would quietly put things back.
 * The plain-text Notes are in it on purpose: they change when a dotted line does.
 */
export function fingerprintOf(data) {
  const canonical = {
    shifts: data.shifts,
    seats: data.seats.map((s) => [s.key ?? '', squeeze(s.title), s.level, Number(s.count), squeeze(s.shift), squeeze(s.department), squeeze(s.location),
      (s.machines ?? []).map((m) => squeeze(m).toLowerCase()).sort(), squeeze(s.notes), s.parent ?? -1]),
    people: data.people.map((p) => [p.key ?? '', squeeze(p.name), p.seat, squeeze(p.shift), squeeze(p.code), isoDay(p.joined)]),
    responsibilities: data.responsibilities.map((x) => [x.key ?? '', x.seat, squeeze(x.text)]),
    machines: data.machines.map((m) => [m.key ?? '', squeeze(m.name), m.kind, squeeze(m.where)]),
    questions: data.questions.map((q) => [q.key ?? '', q.seat ?? -1, squeeze(q.text)]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const colLetter = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};
/** Collapse whitespace the way Excel's TRIM does, so a written title equals what the label formula yields. */
export const squeeze = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const seatRef = (index) => `P${String(index + 1).padStart(3, '0')}`;
export const seatLabel = (index, title) => `${seatRef(index)} — ${squeeze(title)}`;

const levelCols = Array.from({ length: LEVELS }, (_, i) => colLetter(COL.firstLevel + i)); // B .. K
const FIRST_LEVEL_COL = levelCols[0];
const LAST_LEVEL_COL = levelCols[LEVELS - 1];
const LAST_COL = COL.notes;

// --------------------------------------------------------------- formulas ----
/** Structure!A - the seat's reference, from the row number. Empty row, empty Ref. */
export const refFormula = (r) =>
  `IF(LEN(TRIM(${levelCols.map((c) => `${c}${r}`).join('&')}))=0,"","P"&TEXT(ROW()-1,"000"))`;

// Lists row r lines up with Structure row r and reads Structure by INDEX (see the header).
const onThisRow = (c) => `INDEX(${SHEET.structure}!$${c}:$${c},ROW())`;
const filled = (c) => `(LEN(TRIM(${onThisRow(c)}))>0)`;
const listsFormulas = (r, last) => {
  const above = r === 2 ? '0' : `${LISTS.lastLevel}${r - 1}`; // the first data row has nothing above it
  return {
    // how many Level cells hold a title on this Structure row: 1 is right, 0 is blank, 2+ is a mistake
    [LISTS.count]: levelCols.map(filled).join('+'),
    // which Level it is in (only meaningful when exactly one)
    [LISTS.level]: `IF(${LISTS.count}${r}=1,${levelCols.map((c, i) => `${filled(c)}*${i + 1}`).join('+')},0)`,
    // "P012 — Title": the text every drop-down offers and every other sheet stores
    [LISTS.label]: `IF(${LISTS.count}${r}<>1,"","P"&TEXT(ROW()-1,"000")&" — "&TRIM(${levelCols.map(onThisRow).join('&')}))`,
    // the deepest level seen so far, blank rows skipped: what the next row may legally indent under
    [LISTS.lastLevel]: `IF(${LISTS.level}${r}>0,${LISTS.level}${r},${above})`,
    [LISTS.check]: `IF(${LISTS.count}${r}>1,"Two titles in one row",IF(${LISTS.level}${r}>${above}+1,"Skipped a level",""))`,
    // a gap-free list of labels, so the drop-down shows no blank lines
    [LISTS.index]: `IF(${LISTS.label}${r}="","",COUNT(${LISTS.index}$1:${LISTS.index}${r - 1})+1)`,
    [LISTS.list]: `IFERROR(INDEX(${LISTS.label}$2:${LISTS.label}$${last},MATCH(ROW()-1,${LISTS.index}$2:${LISTS.index}$${last},0)),"")`,
  };
};

/** The seat drop-down: exactly as long as the seats there are. Needs Excel 2010 or later. */
const seatListSource = (last) =>
  `OFFSET(${SHEET.lists}!$${LISTS.list}$2,0,0,MAX(1,COUNT(${SHEET.lists}!$${LISTS.index}$2:$${LISTS.index}$${last})),1)`;

/** How many machines or areas one seat may list. */
export const MAX_MACHINES = 15;

/** A machine name as a comparison key: case, spacing and the space after a comma do not matter. */
export const machineKey = (name) => squeeze(name).toLowerCase().replace(/\s*,\s*/g, ',');

/**
 * Cut a "Machines or areas" cell into machine names.
 *
 * The cell is comma-separated, but a machine can have a comma in its own name ("Slitting, Rewinding and Core Cutting
 * Process" is a real one at Karni), so the pieces are matched against the names on `Machines & areas`: the longest run
 * of pieces that spells a known name wins, and anything else stays a single piece. Without this a machine like that
 * could be exported but never read back.
 *
 * @param {string} text
 * @param {Set<string>} knownKeys  machineKey() of every name on the Machines sheet
 * @returns {string[]} the names as typed (squeezed, in order, empty pieces dropped)
 */
export function splitMachineList(text, knownKeys) {
  const pieces = String(text ?? '').split(',').map(squeeze);
  const out = [];
  for (let i = 0; i < pieces.length;) {
    if (!pieces[i]) { i++; continue; }
    let took = 1;
    for (let n = pieces.length - i; n >= 2; n--) {
      if (knownKeys.has(machineKey(pieces.slice(i, i + n).join(',')))) { took = n; break; }
    }
    out.push(pieces.slice(i, i + took).join(', '));
    i += took;
  }
  return out;
}

/**
 * Machines or areas: every comma-separated name must be on `Machines & areas`.
 *
 * The text is cut into pieces with the SUBSTITUTE/REPT/MID split: every comma
 * becomes LEN(text) spaces and piece k is the LEN(text)-wide window starting at
 * (k-1)*LEN(text)+1, trimmed. The spacer and window are LEN(text) long, which is
 * what keeps a long list from sliding out of its window.
 *
 * The usual form of this rule hands MID a ROW(INDIRECT(...)) array and wraps the
 * lot in SUMPRODUCT. This one spells each piece out instead (fifteen of them), so
 * every part is an ordinary scalar formula: nothing volatile, nothing that
 * depends on how an application evaluates arrays, and it can be checked by any
 * spreadsheet engine. A piece past the last comma is allowed to be empty; a piece
 * before it (as in "A,,B" or "A,") must be a known name.
 */
const machineListRule = (c, r) => {
  const t = `${c}${r}`;
  const n = `(LEN(${t})-LEN(SUBSTITUTE(${t},",",""))+1)`;
  const piece = (k) => `TRIM(MID(SUBSTITUTE(${t},",",REPT(" ",LEN(${t}))),${k - 1}*LEN(${t})+1,LEN(${t})))`;
  const ok = (k) => `OR(${n}<${k},ISNUMBER(MATCH(${piece(k)},${NAMES.machines},0)))`;
  return `OR(${t}="",AND(${n}<=${MAX_MACHINES},${Array.from({ length: MAX_MACHINES }, (_, i) => ok(i + 1)).join(',')}))`;
};

/** Exactly one Level cell on this row holds a title. Same-row references only: a rule sees the typed value, not Lists. */
const oneTitleRule = (r) => `${levelCols.map((c) => `(LEN(TRIM($${c}${r}))>0)`).join('+')}=1`;

// ------------------------------------------------------------------ style ----
const INK = 'FF1F2340';
const MUTED = 'FF6B7089';
const REQ = 'FF3F3D91';        // required heading
const OPT = 'FFDADCF2';        // optional heading
const AUTO = 'FF8A8FA3';       // fills itself in
const GRID = 'FFD5D8E5';
const STAIR = 'FFEDEEFB';      // a cell that holds a seat's title
const BAD = 'FFFFD9D9';        // a row that breaks the outline, or a seat that moved
const WARN = 'FFFFF1CC';       // a required cell left empty on a row that is in use
const EXAMPLE_FILL = 'FFF2F2F2';
const EXAMPLE_TEXT = 'FF8C8C8C';
const WHITE = 'FFFFFFFF';
const LINK = 'FF1F4FB4';

const FONT = Object.freeze({ name: 'Calibri', size: 11, color: { argb: INK } });
const thin = { style: 'thin', color: { argb: GRID } };
const BORDER = Object.freeze({ top: thin, left: thin, bottom: thin, right: thin });
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const cfFill = (argb) => ({ type: 'pattern', pattern: 'solid', bgColor: { argb } }); // a conditional format colours bgColor

function styleHeader(cell, kind) {
  const [fill, text] = { required: [REQ, WHITE], optional: [OPT, INK], auto: [AUTO, WHITE] }[kind];
  cell.fill = solid(fill);
  cell.font = { ...FONT, bold: true, color: { argb: text } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = BORDER;
}

function styleBody(cell, { example = false, align = 'left', wrap = true, muted = false, numFmt } = {}) {
  cell.font = example ? { ...FONT, italic: true, color: { argb: EXAMPLE_TEXT } }
    : muted ? { ...FONT, size: 10, color: { argb: MUTED } } : FONT;
  if (example) cell.fill = solid(EXAMPLE_FILL);
  cell.border = BORDER;
  cell.alignment = { vertical: 'top', horizontal: align, wrapText: wrap };
  if (numFmt) cell.numFmt = numFmt;
}

/** Excel silently repairs (i.e. drops) a rule whose prompt or message is too long, so refuse to write one. */
function validation(spec) {
  const over = (s, n) => s != null && String(s).length > n;
  if (over(spec.promptTitle, 32) || over(spec.errorTitle, 32) || over(spec.prompt, 255) || over(spec.error, 255)) {
    throw new Error(`Validation text too long for Excel: ${JSON.stringify(spec).slice(0, 120)}`);
  }
  return { allowBlank: true, showErrorMessage: true, errorStyle: 'stop', showInputMessage: Boolean(spec.prompt), ...spec };
}

// -------------------------------------------------------- example content ----
const EXAMPLE_MODEL = Object.freeze({
  seats: [
    { title: 'Plant manager', level: 1, count: 1, shift: 'General', department: 'Operations', location: 'Main plant', machines: [], notes: `${EXAMPLE_MARK} delete the grey rows before you start.` },
    { title: 'Shift supervisor', level: 2, count: 1, shift: DAY_AND_NIGHT, department: 'Operations', location: 'Main plant', machines: ['Packing line 1'], notes: `${EXAMPLE_MARK} Day & night with 1 means one supervisor on EACH shift.` },
    { title: 'Operator', level: 2, count: 4, shift: 'Day', department: 'Operations', location: 'Main plant', machines: ['Packing line 1'], notes: `${EXAMPLE_MARK} four operators are ONE row with 4, not four rows.` },
    { title: 'Accounts executive', level: 2, count: 1, shift: 'General', department: 'Accounts', location: 'Main plant', machines: [], notes: `${EXAMPLE_MARK} no machine, so that cell stays empty.` },
  ],
  people: [
    { name: `${EXAMPLE_MARK} Asha Verma`, seat: 1, shift: 'Day', code: '', joined: new Date(Date.UTC(2021, 3, 1)) },
    { name: `${EXAMPLE_MARK} Ravi Kumar`, seat: 2, shift: 'Day', code: '', joined: null },
  ],
  responsibilities: [
    { seat: 1, text: `${EXAMPLE_MARK} makes sure the shift reaches its daily output target.` },
    { seat: 1, text: `${EXAMPLE_MARK} signs off the handover note at the end of every shift.` },
    { seat: 2, text: `${EXAMPLE_MARK} runs the packing line to the day's job card.` },
  ],
  machines: [{ name: 'Packing line 1', kind: 'Line', where: `${EXAMPLE_MARK} main plant, east wall` }],
  questions: [{ seat: 0, text: `${EXAMPLE_MARK} who covers the Plant manager when they are on leave?` }],
});

const capFor = (count, floor, headroom) => Math.max(floor, Math.ceil((count + headroom) / 50) * 50);

/** Fill in everything the caller may leave out, and decide how many rows to pre-format. */
function normalise(input) {
  const examples = !input;
  const src = input ?? { ...EXAMPLE_MODEL, company: null, shifts: [...DEFAULT_SHIFTS], startNotes: [] };
  const seats = src.seats.map((s) => ({
    ...s,
    title: squeeze(s.title),
    machines: (s.machines ?? []).map(squeeze).filter(Boolean),
  }));
  // The outline rule, checked here once so a malformed input fails loudly instead of producing a workbook that lies.
  seats.forEach((s, i) => {
    const before = i ? seats[i - 1].level : 0;
    if (!Number.isInteger(s.level) || s.level < 1 || s.level > LEVELS) {
      throw new Error(`Seat "${s.title}" is at level ${s.level}; the workbook has ${LEVELS} Level columns.`);
    }
    if (s.level > before + 1) throw new Error(`Seat "${s.title}" skips from level ${before} to ${s.level}.`);
  });
  const shifts = src.shifts?.length ? [...src.shifts] : [...DEFAULT_SHIFTS];
  return {
    examples,
    company: src.company ?? null,
    generatedOn: src.generatedOn ?? null,
    startNotes: src.startNotes ?? [],
    provenance: src.provenance ?? null, // null = a blank template: no company, no database, every row new
    shifts,
    seats,
    people: src.people ?? [],
    responsibilities: src.responsibilities ?? [],
    machines: src.machines ?? [],
    questions: src.questions ?? [],
    caps: {
      structure: capFor(seats.length, 400, 150),
      people: capFor((src.people ?? []).length, 500, 300),
      responsibilities: capFor((src.responsibilities ?? []).length, 1500, 500),
      machines: capFor((src.machines ?? []).length, 150, 100),
      questions: capFor((src.questions ?? []).length, 400, 200),
    },
  };
}

// ------------------------------------------------------------ the builder ----
/**
 * @param {null|object} input  null = the blank template with grey examples.
 *   Otherwise { company:{name,slug}, generatedOn, shifts:[names], startNotes:[text],
 *     seats:[{title, level, count, shift, department, location, machines:[name], notes}]  (OUTLINE ORDER)
 *     people:[{name, seat:<index>, shift, code, joined:Date|null}],
 *     responsibilities:[{seat:<index>, text}],
 *     machines:[{name, kind, where}],
 *     questions:[{seat:<index>|null, text}] }
 */
export function buildOrgWorkbook(input = null) {
  const model = normalise(input);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF_HRMS';
  wb.lastModifiedBy = 'CF_HRMS';
  wb.created = new Date();
  wb.modified = new Date();
  wb.title = model.company ? `Organisation chart workbook - ${model.company.name}` : 'Organisation chart workbook';
  wb.subject = 'CF_HRMS organisation chart import';
  wb.calcProperties.fullCalcOnLoad = true; // cached results are written too; this makes Excel recompute them on open
  wb.views = [{ x: 0, y: 0, width: 24000, height: 14000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  // Created in the required order; filled below.
  const ws = Object.fromEntries(SHEET_ORDER.map((name) => [name, wb.addWorksheet(name)]));
  ws[SHEET.lists].state = 'hidden';

  const last = {
    structure: model.caps.structure + 1,
    people: model.caps.people + 1,
    responsibilities: model.caps.responsibilities + 1,
    machines: model.caps.machines + 1,
    questions: model.caps.questions + 1,
  };
  const seatShifts = [...model.shifts, DAY_AND_NIGHT];

  buildLists(ws[SHEET.lists], model, last, seatShifts);
  buildStructure(ws[SHEET.structure], model, last.structure);
  buildPeople(ws[SHEET.people], model, last.people);
  buildResponsibilities(ws[SHEET.responsibilities], model, last.responsibilities);
  buildMachines(ws[SHEET.machines], model, last.machines);
  buildQuestions(ws[SHEET.questions], model, last.questions);
  buildStart(ws[SHEET.start], model);

  // Defined names: plain ranges, so the rules read as words and survive a row being deleted.
  const names = wb.definedNames;
  names.add(`${SHEET.lists}!$${LISTS.shiftSeat}$2:$${LISTS.shiftSeat}$${1 + seatShifts.length}`, NAMES.seatShifts);
  names.add(`${SHEET.lists}!$${LISTS.shiftPerson}$2:$${LISTS.shiftPerson}$${1 + model.shifts.length}`, NAMES.personShifts);
  names.add(`${SHEET.lists}!$${LISTS.kind}$2:$${LISTS.kind}$${1 + KINDS.length}`, NAMES.kinds);
  names.add(`${SHEET.lists}!$${LISTS.label}$2:$${LISTS.label}$${last.structure}`, NAMES.seatLabels);
  names.add(`${SHEET.lists}!$${LISTS.check}$2:$${LISTS.check}$${last.structure}`, NAMES.rowCheck);
  names.add(`'${SHEET.machines}'!$A$2:$A$${last.machines}`, NAMES.machines);

  return wb;
}

// ------------------------------------------------------------------ Lists ----
function buildLists(ws, model, last, seatShifts) {
  ws.properties.tabColor = { argb: AUTO };
  const widths = { A: 16, B: 16, C: 12, D: 3, E: 54, F: 11, G: 8, H: 12, I: 22, J: 11, K: 54, L: 3, M: 60 };
  Object.entries(widths).forEach(([c, w]) => { ws.getColumn(c).width = w; });

  const head = (c, text) => {
    const cell = ws.getCell(`${c}1`);
    cell.value = text;
    cell.font = { ...FONT, bold: true };
  };
  head(LISTS.shiftSeat, 'Shift (seats)');
  head(LISTS.shiftPerson, 'Shift (people)');
  head(LISTS.kind, 'Kind');
  head(LISTS.label, 'Seat label, by Structure row');
  head(LISTS.count, 'Titles in row');
  head(LISTS.level, 'Level');
  head(LISTS.lastLevel, 'Last level');
  head(LISTS.check, 'Row check');
  head(LISTS.index, 'Seat no.');
  head(LISTS.list, 'Seat list (no gaps)');
  ws.getCell('M1').value = 'Plumbing for the other sheets. Nothing here needs editing.';
  ws.getCell('M2').value = 'Rows 2 onward line up with the same row numbers on Structure.';
  ['M1', 'M2'].forEach((a) => { ws.getCell(a).font = { ...FONT, italic: true, color: { argb: MUTED } }; });

  seatShifts.forEach((v, i) => { ws.getCell(`${LISTS.shiftSeat}${i + 2}`).value = v; });
  model.shifts.forEach((v, i) => { ws.getCell(`${LISTS.shiftPerson}${i + 2}`).value = v; });
  KINDS.forEach((v, i) => { ws.getCell(`${LISTS.kind}${i + 2}`).value = v; });

  // Cached results mirror the formulas row by row, so a viewer that does not recalculate still shows the truth.
  let lastLevel = 0;
  let numbered = 0;
  for (let r = 2; r <= last.structure; r++) {
    const seat = model.seats[r - 2] ?? null;
    const level = seat ? seat.level : 0;
    const result = {
      [LISTS.count]: seat ? 1 : 0,
      [LISTS.level]: level,
      [LISTS.label]: seat ? seatLabel(r - 2, seat.title) : '',
      [LISTS.lastLevel]: level > 0 ? level : lastLevel,
      [LISTS.check]: level > lastLevel + 1 ? 'Skipped a level' : '',
      [LISTS.index]: seat ? ++numbered : '',
      [LISTS.list]: seat ? seatLabel(r - 2, seat.title) : '',
    };
    lastLevel = result[LISTS.lastLevel];
    const formulas = listsFormulas(r, last.structure);
    for (const c of Object.keys(formulas)) ws.getCell(`${c}${r}`).value = { formula: formulas[c], result: result[c] };
  }
}

// -------------------------------------------------------------- Structure ----
function buildStructure(ws, model, lastRow) {
  ws.properties.tabColor = { argb: REQ };
  const widths = [7.5, ...Array(LEVELS).fill(11), 10, 13, 18, 16, 32, 38, 14];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const headers = HEADERS.structure;
  const required = new Set([...levelCols.map((_, i) => COL.firstLevel + i), COL.count, COL.shift]);
  headers.forEach((text, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = text;
    styleHeader(cell, i + 1 === COL.ref || i + 1 === COL.key ? 'auto' : required.has(i + 1) ? 'required' : 'optional');
  });
  ws.getRow(1).height = 36;
  ws.getColumn(COL.key).hidden = true; // hidden and muted, deliberately not protected (see the header comment)

  for (let r = 2; r <= lastRow; r++) {
    const i = r - 2;
    const seat = model.seats[i] ?? null;
    const example = model.examples && Boolean(seat);
    for (let c = 1; c <= COL.key; c++) {
      const cell = ws.getCell(r, c);
      styleBody(cell, {
        example,
        muted: c === COL.ref || c === COL.key,
        align: c === COL.ref || c === COL.count ? 'center' : 'left',
        wrap: c !== COL.ref && c !== COL.key,
      });
    }
    ws.getCell(r, COL.ref).value = { formula: refFormula(r), result: seat ? seatRef(i) : '' };
    if (!seat) continue;
    if (seat.key) ws.getCell(r, COL.key).value = seat.key;
    ws.getCell(r, COL.firstLevel + seat.level - 1).value = seat.title;
    ws.getCell(r, COL.count).value = seat.count ?? 1;
    if (seat.shift) ws.getCell(r, COL.shift).value = seat.shift;
    if (seat.department) ws.getCell(r, COL.department).value = squeeze(seat.department);
    if (seat.location) ws.getCell(r, COL.location).value = squeeze(seat.location);
    if (seat.machines.length) ws.getCell(r, COL.machines).value = seat.machines.join(', ');
    if (seat.notes) ws.getCell(r, COL.notes).value = squeeze(seat.notes);
  }

  // Freeze the heading AND the Ref + all ten Level columns, so the outline stays in view while the other columns scroll.
  ws.views = [{ state: 'frozen', xSplit: COL.lastLevel, ySplit: 1, topLeftCell: `${colLetter(COL.lastLevel + 1)}2`, activeCell: `${colLetter(COL.lastLevel + 1)}2` }];
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };

  const rng = (c) => `${colLetter(c)}2:${colLetter(c)}${lastRow}`;
  const levelRange = `${FIRST_LEVEL_COL}2:${LAST_LEVEL_COL}${lastRow}`;
  const dv = (ref, spec) => ws.dataValidations.add(ref, validation(spec));

  dv(levelRange, {
    type: 'custom',
    formulae: [oneTitleRule(2)],
    errorTitle: 'One title per row',
    error: 'Each row is one seat, so its title goes in ONE Level column only. To move a seat to another level, cut the cell and paste it into the new column.',
  });
  dv(rng(COL.count), {
    type: 'decimal', operator: 'between', formulae: [0, 1000],
    promptTitle: 'How many people?',
    prompt: 'People needed in this seat. For a Day & night seat, the number needed on EACH shift.',
    errorTitle: 'Enter a number', error: 'Type a number such as 1 or 2.',
  });
  dv(rng(COL.shift), {
    type: 'list', formulae: [NAMES.seatShifts],
    promptTitle: 'Shift',
    prompt: 'Day & night means the seat runs both shifts. Count the people needed per shift.',
    errorTitle: 'Pick from the list', error: 'Choose one of the shifts in the list.',
  });
  dv(rng(COL.machines), {
    type: 'custom', errorStyle: 'warning',
    formulae: [machineListRule(colLetter(COL.machines), 2)],
    promptTitle: 'Machines or areas',
    prompt: `Names from the Machines & areas sheet, separated by commas (up to ${MAX_MACHINES}).`,
    errorTitle: 'Machine or area not found',
    error: `One or more names are not on the Machines & areas sheet, or more than ${MAX_MACHINES} are listed. Check the spelling, or add the machine there first.`,
  });
  dv(rng(COL.ref), {
    type: 'any', allowBlank: true, showErrorMessage: false,
    promptTitle: 'Ref', prompt: 'Fills itself in. Never type here.',
  });

  // Conditional formats. Lower number = wins.
  const allCols = `A2:${colLetter(LAST_COL)}${lastRow}`;
  ws.addConditionalFormatting({
    ref: allCols,
    rules: [{ type: 'expression', priority: 1, formulae: [`LEN(INDEX(${NAMES.rowCheck},ROW()-1))>0`], style: { fill: cfFill(BAD) } }],
  });
  const anyTitle = `LEN(TRIM(${levelCols.map((c) => `$${c}2`).join('&')}))>0`;
  ws.addConditionalFormatting({
    ref: `${colLetter(COL.count)}2:${colLetter(COL.shift)}${lastRow}`,
    rules: [{
      type: 'expression', priority: 2,
      formulae: [`AND(${anyTitle},LEN(TRIM(${colLetter(COL.count)}2))=0)`],
      style: { fill: cfFill(WARN) },
    }],
  });
  ws.addConditionalFormatting({
    ref: levelRange,
    rules: [{
      type: 'expression', priority: 3,
      // an example row (marked in Notes) keeps its grey instead
      formulae: [`AND(LEN(TRIM(${FIRST_LEVEL_COL}2))>0,LEFT($${colLetter(COL.notes)}2,${EXAMPLE_MARK.length})<>"${EXAMPLE_MARK}")`],
      style: { fill: cfFill(STAIR), font: { bold: true } },
    }],
  });
}

// --------------------------------------------------- the pick-a-seat sheets ----
/** People, Responsibilities, Questions: a few columns, each cell styled, rows pre-formatted to `lastRow`. */
function fillSimpleSheet(ws, { headers, kinds, widths, lastRow, rows, formats = [] }) {
  const keyCol = headers.length; // the last heading is always the hidden key; `kinds` and `widths` cover the visible ones
  headers.forEach((text, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = text;
    styleHeader(cell, i + 1 === keyCol ? 'auto' : kinds[i]);
    ws.getColumn(i + 1).width = i + 1 === keyCol ? 14 : widths[i];
  });
  ws.getColumn(keyCol).hidden = true; // hidden and muted, deliberately not protected (see the header comment)
  ws.getRow(1).height = 24;
  ws.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
  for (let r = 2; r <= lastRow; r++) {
    const row = rows[r - 2];
    for (let c = 1; c <= headers.length; c++) {
      const cell = ws.getCell(r, c);
      styleBody(cell, { example: Boolean(row?.example), numFmt: formats[c - 1], muted: c === keyCol, wrap: c !== keyCol });
      const v = row?.values[c - 1];
      if (v != null && v !== '') cell.value = v;
    }
  }
}

/**
 * A seat cell turns red when the label in it no longer exists (a row was inserted or deleted, or a title changed).
 * An exact comparison, not COUNTIF or MATCH: those read * ? ~ as wildcards ("Incoming QC?" is a real title) and
 * read a leading < > = as an operator, so each would need escaping and still differ between spreadsheet programs.
 */
function addSeatChecks(ws, col, lastRow, priority) {
  ws.addConditionalFormatting({
    ref: `${col}2:${col}${lastRow}`,
    rules: [{
      type: 'expression', priority,
      formulae: [`AND(LEN(${col}2)>0,SUMPRODUCT(--(${NAMES.seatLabels}=${col}2))=0)`],
      style: { fill: cfFill(BAD) },
    }],
  });
}

/** A required cell turns amber when the rest of its row is in use and it is still empty. */
function addRequiredChecks(ws, { cols, spanFrom, spanTo, lastRow, priority }) {
  cols.forEach((col, k) => {
    const row = `$${spanFrom}2:$${spanTo}2`;
    ws.addConditionalFormatting({
      ref: `${col}2:${col}${lastRow}`,
      rules: [{
        type: 'expression', priority: priority + k,
        formulae: [`AND(COUNTA(${row})>0,LEN(TRIM(${col}2))=0)`],
        style: { fill: cfFill(WARN) },
      }],
    });
  });
}

const seatPickValidation = (lastLists, { optional = false } = {}) => validation({
  type: 'list',
  formulae: [seatListSource(lastLists)],
  promptTitle: 'Seat',
  prompt: 'Pick the seat. Its Ref is in column A of the Structure sheet.',
  errorTitle: 'Pick a seat', error: 'Choose a seat from the list. Add the seat on the Structure sheet first if it is not there.',
  allowBlank: optional,
});

// ----------------------------------------------------------------- People ----
function buildPeople(ws, model, lastRow) {
  ws.properties.tabColor = { argb: 'FF6C6FB8' };
  const rows = model.people.map((p) => ({
    example: model.examples,
    values: [squeeze(p.name), seatLabel(p.seat, model.seats[p.seat].title), p.shift ?? '', squeeze(p.code), p.joined ?? null, p.key ?? ''],
  }));
  fillSimpleSheet(ws, {
    headers: HEADERS.people, kinds: ['required', 'required', 'required', 'optional', 'optional'],
    widths: [30, 54, 13, 24, 16], lastRow, rows, formats: [null, null, null, null, 'dd-mmm-yyyy'],
  });

  ws.dataValidations.add(`B2:B${lastRow}`, seatPickValidation(model.caps.structure + 1));
  ws.dataValidations.add(`C2:C${lastRow}`, validation({
    type: 'list', formulae: [NAMES.personShifts],
    errorTitle: 'Pick from the list', error: 'Choose one of the shifts in the list.',
  }));
  ws.dataValidations.add(`E2:E${lastRow}`, validation({
    type: 'date', operator: 'between', formulae: [new Date(Date.UTC(1930, 0, 1)), new Date(Date.UTC(2100, 11, 31))],
    errorTitle: 'Enter a date', error: 'Type a date such as 01-Apr-2021.',
  }));
  addSeatChecks(ws, 'B', lastRow, 1);
  addRequiredChecks(ws, { cols: ['A', 'B', 'C'], spanFrom: 'A', spanTo: 'E', lastRow, priority: 2 });
}

// -------------------------------------------------------- Responsibilities ----
function buildResponsibilities(ws, model, lastRow) {
  ws.properties.tabColor = { argb: 'FF6C6FB8' };
  const rows = model.responsibilities.map((x) => ({
    example: model.examples,
    values: [seatLabel(x.seat, model.seats[x.seat].title), squeeze(x.text), x.key ?? ''],
  }));
  fillSimpleSheet(ws, {
    headers: HEADERS.responsibilities, kinds: ['required', 'required'], widths: [54, 110], lastRow, rows,
  });
  ws.dataValidations.add(`A2:A${lastRow}`, seatPickValidation(model.caps.structure + 1));
  addSeatChecks(ws, 'A', lastRow, 1);
  addRequiredChecks(ws, { cols: ['A', 'B'], spanFrom: 'A', spanTo: 'B', lastRow, priority: 2 });
}

// ------------------------------------------------------- Machines & areas ----
function buildMachines(ws, model, lastRow) {
  ws.properties.tabColor = { argb: 'FF6C6FB8' };
  const rows = model.machines.map((m) => ({
    example: model.examples,
    values: [squeeze(m.name), m.kind ?? 'Machine', squeeze(m.where), m.key ?? ''],
  }));
  fillSimpleSheet(ws, {
    headers: HEADERS.machines, kinds: ['required', 'required', 'optional'], widths: [36, 14, 36], lastRow, rows,
  });
  ws.dataValidations.add(`A2:A${lastRow}`, validation({
    type: 'custom',
    formulae: [`AND(ISERROR(FIND(",",A2)),COUNTIF($A$2:$A$${lastRow},A2)=1)`],
    errorTitle: 'Use a plain, unique name',
    error: 'A name cannot contain a comma (commas separate machines on the Structure sheet) and cannot be listed twice.',
  }));
  ws.dataValidations.add(`B2:B${lastRow}`, validation({
    type: 'list', formulae: [NAMES.kinds],
    errorTitle: 'Pick from the list', error: 'Choose Machine, Line, Area, Project, Cell or Other.',
  }));
  addRequiredChecks(ws, { cols: ['A', 'B'], spanFrom: 'A', spanTo: 'C', lastRow, priority: 1 });
}

// ------------------------------------------------------ Questions & doubts ----
function buildQuestions(ws, model, lastRow) {
  ws.properties.tabColor = { argb: 'FF6C6FB8' };
  const rows = model.questions.map((q) => ({
    example: model.examples,
    values: [q.seat == null ? '' : seatLabel(q.seat, model.seats[q.seat].title), squeeze(q.text), q.key ?? ''],
  }));
  fillSimpleSheet(ws, {
    headers: HEADERS.questions, kinds: ['optional', 'required'], widths: [54, 110], lastRow, rows,
  });
  ws.dataValidations.add(`A2:A${lastRow}`, seatPickValidation(model.caps.structure + 1, { optional: true }));
  addSeatChecks(ws, 'A', lastRow, 1);
  addRequiredChecks(ws, { cols: ['B'], spanFrom: 'A', spanTo: 'B', lastRow, priority: 2 });
}

// ------------------------------------------------------------- Start here ----
/** The words on `Start here`. Plain English, no jargon, about one screen. Edit here. */
const TEXT = Object.freeze({
  title: 'Organisation chart workbook',
  blank: 'Fill this in once and your whole organisation is set up in one go: the seats, the people in them, what each seat is responsible for, the machines, and the questions still open.',
  sheets: [
    ['Structure', 'Every seat in the organisation, top to bottom, like an indented list. Put each seat\'s title in ONE of the Level columns. It reports to the nearest row above it that sits one column to the left.'],
    ['People', 'Who sits in which seat. Pick the seat from the list.'],
    ['Responsibilities', 'One line per duty: pick the seat, write the duty.'],
    ['Machines & areas', 'Every machine, line or area people work on. Name them here once, then pick them on Structure.'],
    ['Questions & doubts', 'Anything still undecided, about one seat or about the whole organisation.'],
  ],
  wrong: [
    ['A seat is not a person.', 'One row on Structure is one SEAT. Need four operators? That is one row with 4 in "How many people?", not four rows. Names go on the People sheet.'],
    ['A machine is never a manager.', 'Machines do not go on Structure. List them on Machines & areas, then name them on the seat that works them.'],
    ['Day and night is counted per shift.', 'If a seat runs both shifts, choose "Day & night" and write how many people it needs on EACH shift. Two on days and two on nights is 2, not 4.'],
  ],
  headings: [
    ['required', 'Dark heading: you must fill it in'],
    ['optional', 'Light heading: optional'],
    ['auto', 'Grey heading: fills itself in'],
  ],
  good: [
    ['Never type an ID.', ' Ref fills itself in, and everywhere else you pick the seat from a list.'],
    ['Same title, same job.', ' Seats with one title share one list of responsibilities, so write each duty once.'],
    ['One person in two seats?', ' Add them twice on People, with the same name.'],
  ],
  goodRowsBlank: ['Leave the Structure rows where they are.', ' Ref follows the row, so inserting or deleting rows moves seats about. A seat picked elsewhere that turns red must be picked again.'],
  goodRowsFilled: [
    ['Sending it back updates the system.', ' A hidden column at the far right of each sheet (Key) remembers which record each row is. Leave it alone: a row with a key changes that record, and a row with no key is added as new.'],
    ['To add a seat,', ' insert a row where it belongs. For a similar seat, copy a whole row and paste it below: the copy is added as a new seat and the original is untouched.'],
    ['To remove something,', ' delete its row. It is only removed when whoever applies the file asks for removals; otherwise it is left as it is.'],
    ['Ref only counts the rows in this copy.', ' Inserting or deleting rows renumbers it. A seat picked on another sheet that turns red is still understood if you did not change it; for a row you add, pick the seat again.'],
    ['Two things are not saved.', ' The Notes column (the system writes it, and what you type there is not kept) and the order of rows: seats under one manager, and duties under one role, always come back in the system\'s own order.'],
  ],
  goodBlank: ['Nothing is locked.', ' Delete the grey example rows before you send this back.'],
  goodFilled: ['The working sheets are not locked.', ' Change anything that is wrong, add what is missing, delete what is gone.'],
});

function buildStart(ws, model) {
  ws.properties.tabColor = { argb: REQ };
  ws.views = [{ showGridLines: false }];
  // Four columns so the colour key can sit on one row: B is the label, C:E together are the text.
  const W = { margin: 2.5, label: 27, c: 22, d: 22, e: 52 };
  const body = W.c + W.d + W.e;
  const whole = W.label + body;
  [W.margin, W.label, W.c, W.d, W.e].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Excel never auto-fits a merged cell, so every height here is estimated from the text length (a little generous).
  const lines = (text, width) => Math.max(1, Math.ceil(String(text).length / Math.floor(width * 1.02)));
  const heightFor = (...pairs) => Math.max(...pairs.map(([text, width]) => lines(text, width))) * 15 + 5;
  const font = (extra = {}) => ({ ...FONT, ...extra });
  let r = 1;
  const gap = (h = 6) => { ws.getRow(r++).height = h; };
  const across = (from, to) => { ws.mergeCells(r, from, r, to); return ws.getCell(r, from); };
  const rule = { bottom: { style: 'thin', color: { argb: REQ } } };

  // Section labels and the title are not merged: their text simply runs on into the empty cells beside them.
  const section = (text) => {
    const cell = ws.getCell(r, 2);
    cell.value = text;
    cell.font = font({ bold: true, size: 10, color: { argb: REQ } });
    cell.alignment = { vertical: 'bottom' };
    for (let c = 2; c <= 5; c++) ws.getCell(r, c).border = rule;
    ws.getRow(r++).height = 20;
  };

  gap(8);
  {
    const cell = ws.getCell(r, 2);
    cell.value = TEXT.title;
    cell.font = font({ bold: true, size: 22 });
    cell.alignment = { vertical: 'middle' };
    ws.getRow(r++).height = 34;
  }
  {
    const cell = across(2, 5);
    let sub = TEXT.blank;
    if (model.company) {
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      sub = `Filled in from what ${model.company.name} has in the system${model.generatedOn ? ` on ${model.generatedOn}` : ''}: `
        + `${n(model.seats.length, 'seat', 'seats')}, ${n(model.people.length, 'person', 'people')}, `
        + `${n(model.responsibilities.length, 'responsibility', 'responsibilities')}, ${n(model.machines.length, 'machine or area', 'machines and areas')}, `
        + `${n(model.questions.length, 'open question', 'open questions')}. Correct what is wrong, add what is missing, and send it back.`;
    }
    cell.value = sub;
    cell.font = font({ color: { argb: MUTED } });
    cell.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(r++).height = heightFor([sub, whole]);
  }
  gap();

  section('THE SHEETS');
  for (const [name, text] of TEXT.sheets) {
    const link = ws.getCell(r, 2);
    const target = /\s|&/.test(name) ? `'${name}'` : name;
    link.value = { formula: `HYPERLINK("#${target}!A1","${name}")`, result: name };
    link.font = font({ bold: true, color: { argb: LINK }, underline: true });
    link.alignment = { vertical: 'top' };
    const cell = across(3, 5);
    cell.value = text;
    cell.font = font();
    cell.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(r++).height = heightFor([text, body]);
  }
  gap();

  section('THREE THINGS PEOPLE GET WRONG');
  for (const [lead, text] of TEXT.wrong) {
    const a = ws.getCell(r, 2);
    a.value = lead;
    a.font = font({ bold: true });
    a.alignment = { vertical: 'top', wrapText: true };
    const cell = across(3, 5);
    cell.value = text;
    cell.font = font();
    cell.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(r++).height = heightFor([lead, W.label], [text, body]);
  }
  gap();

  section('THE COLUMN HEADINGS');
  TEXT.headings.forEach(([kind, label], i) => {
    const cell = ws.getCell(r, 2 + i);
    cell.value = label;
    styleHeader(cell, kind);
  });
  ws.getRow(r++).height = 34;
  gap();

  section('GOOD TO KNOW');
  const good = [
    ...TEXT.good,
    ...(model.examples ? [TEXT.goodRowsBlank] : TEXT.goodRowsFilled),
    model.examples ? TEXT.goodBlank : TEXT.goodFilled,
  ];
  for (const note of model.startNotes) good.push(['About this copy.', ` ${note}`]);
  for (const [lead, rest] of good) {
    const cell = across(2, 5);
    cell.value = { richText: [{ font: font({ bold: true }), text: `• ${lead}` }, { font: font(), text: rest }] };
    cell.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(r++).height = heightFor([`• ${lead}${rest}`, whole]);
  }
  gap(10);
  writeProvenance(ws, model, r + 1);
}

/**
 * Who this copy came from, in locked, hidden rows at the foot of `Start here`: column B names the field
 * (provenance.<field>), column C holds it. A reader finds it by those names, not by row number.
 * A blank template writes nothing, which is how a reader knows every row in it is new.
 *
 * Locked cells only mean something on a protected sheet, so this sheet - and only this one - is protected.
 * There is no password: it guards against accidents, not against people. The working sheets stay unprotected
 * because Excel will not delete a row that holds a locked cell, and deleting rows must keep working.
 */
function writeProvenance(ws, model, firstRow) {
  const p = model.provenance;
  if (!p) return;
  const rows = [
    ['schemaVersion', p.schemaVersion ?? SCHEMA_VERSION],
    ['companySlug', p.companySlug],
    ['companyId', p.companyId],
    ['target', p.target],
    ['targetName', p.targetName],
    ['exportedAt', p.exportedAt],
    ['contentHash', p.contentHash],
    ['counts', JSON.stringify(p.counts ?? {})],
  ];
  rows.forEach(([field, value], i) => {
    const row = ws.getRow(firstRow + i);
    const label = row.getCell(2);
    const cell = row.getCell(3);
    label.value = PROVENANCE_PREFIX + field;
    cell.value = value;
    for (const c of [label, cell]) {
      c.font = { ...FONT, size: 9, color: { argb: MUTED } };
      c.alignment = { vertical: 'top', wrapText: false };
      c.protection = { locked: true };
    }
    row.hidden = true;
  });
  ws.sheetProtection = { sheet: true };
}

/**
 * The provenance block of a Start here sheet as { field: text }, or null when there is none.
 * Values come back as text (a number is "60006"); a reader that wants a number converts it.
 */
export function readProvenanceBlock(sheet) {
  if (!sheet) return null;
  const found = {};
  for (let r = 1; r <= sheet.rowCount; r++) {
    const label = cellText(sheet.getRow(r).getCell(2).value);
    if (!label.startsWith(PROVENANCE_PREFIX)) continue;
    found[label.slice(PROVENANCE_PREFIX.length)] = cellText(sheet.getRow(r).getCell(3).value);
  }
  return Object.keys(found).length ? found : null;
}

// ----------------------------------------------------- reading one back in ----
/** A cell's value as plain text, whatever ExcelJS made of it (formula result, rich text, link). */
export function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.error) return String(v.error);
  }
  return String(v);
}

/**
 * The outline rule, in one place. Walk Structure top to bottom; a row at Level N
 * is the child of the most recent row at Level N-1 that no shallower row has
 * since closed. A row that finds no such parent skipped a level; a row with two
 * titles is ambiguous. Both are reported, never guessed at.
 *
 * @returns {{row:number, ref:string, level:number|null, title:string, parent:number|null, problem:string|null}[]}
 *   `parent` is an index into the returned array (not a row number); null for a root.
 */
export function readOutline(sheet) {
  const out = [];
  const open = new Array(LEVELS + 1).fill(null); // open[level] = index in `out` of the latest row at that level
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const titles = [];
    for (let k = 1; k <= LEVELS; k++) {
      const t = squeeze(cellText(row.getCell(COL.firstLevel + k - 1).value));
      if (t) titles.push({ level: k, title: t });
    }
    if (!titles.length) continue;
    if (titles.length > 1) {
      out.push({ row: r, ref: seatRef(r - 2), level: null, title: titles.map((t) => t.title).join(' | '), parent: null, problem: 'Two titles in one row' });
      continue;
    }
    const { level, title } = titles[0];
    let parent = null;
    let problem = null;
    if (level > 1) {
      parent = open[level - 1];
      if (parent == null) problem = 'Skipped a level';
    }
    out.push({ row: r, ref: seatRef(r - 2), level, title, parent, problem });
    open[level] = out.length - 1;
    for (let k = level + 1; k <= LEVELS; k++) open[k] = null;
  }
  return out;
}

/** Rows of a sheet that hold anything in the first `width` columns, as trimmed text. */
export function usedRows(sheet, width) {
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const values = Array.from({ length: width }, (_, c) => squeeze(cellText(sheet.getRow(r).getCell(c + 1).value)));
    if (values.some(Boolean)) rows.push({ row: r, values });
  }
  return rows;
}
export const isExampleRow = (values) => values.some((v) => v.startsWith(EXAMPLE_MARK));

/**
 * Open a written workbook and prove it is the workbook this module promises.
 * Returns { problems, stats }; an empty `problems` means every check passed.
 *
 * @param {ExcelJS.Workbook} wb  a workbook READ BACK from disk, not the in-memory one
 * @param {null|object} expected the same `input` the workbook was built from (null for the blank template)
 */
export function checkOrgWorkbook(wb, expected = null) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };

  need(JSON.stringify(wb.worksheets.map((w) => w.name)) === JSON.stringify(SHEET_ORDER),
    `sheets are [${wb.worksheets.map((w) => w.name).join(' | ')}], expected [${SHEET_ORDER.join(' | ')}]`);
  for (const w of wb.worksheets) {
    need((w.state === 'hidden') === (w.name === SHEET.lists), `${w.name} is ${w.state}`);
    // Only Start here may be protected, and only because it holds the locked provenance rows. A protected working
    // sheet would stop anyone deleting a row that contains a locked cell (the Key).
    const shouldBeProtected = Boolean(expected) && w.name === SHEET.start;
    need(Boolean(w.sheetProtection?.sheet) === shouldBeProtected, `${w.name} is ${w.sheetProtection?.sheet ? 'protected' : 'not protected'}`);
  }

  const headerKeys = { structure: SHEET.structure, people: SHEET.people, responsibilities: SHEET.responsibilities, machines: SHEET.machines, questions: SHEET.questions };
  for (const [key, name] of Object.entries(headerKeys)) {
    const w = wb.getWorksheet(name);
    if (!w) continue;
    const got = HEADERS[key].map((_, i) => cellText(w.getRow(1).getCell(i + 1).value));
    need(JSON.stringify(got) === JSON.stringify(HEADERS[key]), `${name} headings are [${got.join(' | ')}]`);
    const view = w.views?.[0];
    need(view?.state === 'frozen' && view.ySplit === 1, `${name} heading row is not frozen`);
    if (key === 'structure') need(view?.xSplit === COL.lastLevel, `Structure is frozen at column ${view?.xSplit}, expected ${COL.lastLevel}`);
    need(w.getColumn(KEY_COLUMN[key]).hidden === true, `${name}: the Key column is not hidden`);
  }

  // ---- provenance: present, hidden and correct on a pre-filled workbook; absent on a blank template ----
  const start = wb.getWorksheet(SHEET.start);
  const provenance = readProvenanceBlock(start);
  if (!expected) {
    need(!provenance, 'a blank template carries a provenance block');
  } else {
    need(Boolean(provenance), 'Start here has no provenance block');
    const want = expected.provenance;
    if (provenance && want) {
      const same = (field, wanted) => need(provenance[field] === String(wanted), `provenance.${field} is "${provenance[field]}", expected "${wanted}"`);
      same('schemaVersion', want.schemaVersion ?? SCHEMA_VERSION);
      same('companySlug', want.companySlug);
      same('companyId', want.companyId);
      same('target', want.target);
      same('exportedAt', want.exportedAt);
      same('contentHash', want.contentHash);
      same('counts', JSON.stringify(want.counts ?? {}));
      for (let r = 1; r <= start.rowCount; r++) {
        if (cellText(start.getRow(r).getCell(2).value).startsWith(PROVENANCE_PREFIX)) need(start.getRow(r).hidden === true, `Start here row ${r} (provenance) is not hidden`);
      }
    }
  }

  const structure = wb.getWorksheet(SHEET.structure);
  const lists = wb.getWorksheet(SHEET.lists);
  const stats = {};
  if (structure && lists) {
    const a2 = structure.getCell('A2').value;
    const aLast = structure.getCell(structure.rowCount, 1).value;
    need(a2?.formula && /ROW\(\)-1/.test(a2.formula), 'Structure!A2 is not the Ref formula');
    need(aLast?.formula && /ROW\(\)-1/.test(aLast.formula), 'Structure!A in the last pre-formatted row is not the Ref formula');

    // ExcelJS hands a range's rule back cell by cell, so ask the first data row of each column.
    const dvOf = (name, col) => wb.getWorksheet(name).getCell(`${col}2`).dataValidation;
    need(dvOf(SHEET.structure, colLetter(COL.shift))?.type === 'list', 'Structure Shift has no drop-down');
    need(dvOf(SHEET.structure, colLetter(COL.machines))?.type === 'custom', 'Structure Machines has no rule');
    need(dvOf(SHEET.structure, FIRST_LEVEL_COL)?.type === 'custom', 'Structure Level columns have no one-title rule');
    need(dvOf(SHEET.people, 'B')?.type === 'list', 'People Seat has no drop-down');
    need(dvOf(SHEET.people, 'C')?.type === 'list', 'People Shift has no drop-down');
    need(dvOf(SHEET.responsibilities, 'A')?.type === 'list', 'Responsibilities Seat has no drop-down');
    need(dvOf(SHEET.machines, 'B')?.type === 'list', 'Machines Kind has no drop-down');
    need(dvOf(SHEET.questions, 'A')?.type === 'list', 'Questions About has no drop-down');
    stats.dropdowns = Object.values(headerKeys).reduce((n, name) => {
      const w = wb.getWorksheet(name);
      return n + Array.from({ length: w.columnCount }, (_, c) => w.getCell(2, c + 1).dataValidation?.type).filter((t) => t === 'list').length;
    }, 0);

    const names = new Set((wb.definedNames?.model ?? []).map((n) => n.name));
    for (const n of Object.values(NAMES)) need(names.has(n), `defined name ${n} is missing`);

    // ---- what the workbook says, read back through the outline rule ----
    const outline = readOutline(structure);
    const bad = outline.filter((o) => o.problem);
    need(bad.length === 0, `outline problems: ${bad.slice(0, 3).map((o) => `row ${o.row} ${o.problem}`).join('; ')}`);
    const labels = new Set(outline.filter((o) => !o.problem).map((o) => seatLabel(o.row - 2, o.title)));
    const machinesSeen = new Set(usedRows(wb.getWorksheet(SHEET.machines), 3).map((x) => machineKey(x.values[0])));

    const people = usedRows(wb.getWorksheet(SHEET.people), 5);
    const resp = usedRows(wb.getWorksheet(SHEET.responsibilities), 2);
    const machines = usedRows(wb.getWorksheet(SHEET.machines), 3);
    const questions = usedRows(wb.getWorksheet(SHEET.questions), 2);
    const structRows = usedRows(structure, LAST_COL);
    Object.assign(stats, {
      seats: outline.length,
      deepestLevel: Math.max(0, ...outline.map((o) => o.level ?? 0)),
      people: people.length, responsibilities: resp.length, machines: machines.length, questions: questions.length,
      exampleRows: [structRows, people, resp, machines, questions].reduce((n, rows) => n + rows.filter((x) => isExampleRow(x.values)).length, 0),
    });

    // ---- the keys: what a reader will use to know which record each row is ----
    const keyAt = (sheetName, r, key) => squeeze(cellText(wb.getWorksheet(sheetName).getRow(r).getCell(KEY_COLUMN[key]).value));
    const checkKeys = (what, rows, sheetName, key, wanted) => {
      rows.forEach((x, i) => {
        const got = keyAt(sheetName, x.row, key);
        need(got === (wanted[i]?.key ?? ''), `${what} row ${x.row}: key "${got}", expected "${wanted[i]?.key ?? ''}"`);
        if (got) need(KEY_KINDS[key].includes(parseKey(got)?.kind), `${what} row ${x.row}: "${got}" is not a ${KEY_KINDS[key].join('/')} key`);
      });
    };
    if (expected) {
      checkKeys('Structure', outline.map((o) => ({ row: o.row })), SHEET.structure, 'structure', expected.seats);
      checkKeys('People', people, SHEET.people, 'people', expected.people);
      checkKeys('Responsibilities', resp, SHEET.responsibilities, 'responsibilities', expected.responsibilities);
      checkKeys('Machines', machines, SHEET.machines, 'machines', expected.machines);
      checkKeys('Questions', questions, SHEET.questions, 'questions', expected.questions);
    } else {
      for (const [key, name] of Object.entries(headerKeys)) {
        const w = wb.getWorksheet(name);
        for (let r = 2; r <= w.rowCount; r++) need(keyAt(name, r, key) === '', `${name} row ${r}: a blank template holds a key`);
      }
    }

    for (const x of people) need(labels.has(x.values[1]), `People row ${x.row}: seat "${x.values[1]}" is not on Structure`);
    for (const x of resp) need(labels.has(x.values[0]), `Responsibilities row ${x.row}: seat "${x.values[0]}" is not on Structure`);
    for (const x of questions) need(!x.values[0] || labels.has(x.values[0]), `Questions row ${x.row}: seat "${x.values[0]}" is not on Structure`);
    for (const x of structRows) {
      const text = x.values[COL.machines - 1];
      for (const name of splitMachineList(text, machinesSeen)) {
        need(machinesSeen.has(machineKey(name)), `Structure row ${x.row}: "${name}" is not on Machines & areas`);
      }
    }

    // ---- against the data it was built from ----
    if (expected) {
      const eq = (a, b, what) => need(a === b, `${what}: workbook ${a}, expected ${b}`);
      eq(outline.length, expected.seats.length, 'structure rows');
      eq(people.length, expected.people.length, 'people');
      eq(resp.length, expected.responsibilities.length, 'responsibilities');
      eq(machines.length, expected.machines.length, 'machines');
      eq(questions.length, expected.questions.length, 'questions');
      eq(stats.exampleRows, 0, 'example rows left in a filled workbook');
      expected.seats.forEach((seat, i) => {
        const got = outline[i];
        if (!got) return;
        need(got.title === squeeze(seat.title), `row ${got.row}: title "${got.title}" != "${squeeze(seat.title)}"`);
        need(got.level === seat.level, `row ${got.row}: level ${got.level} != ${seat.level}`);
        const wantParent = seat.parent == null ? null : seat.parent;
        need(got.parent === wantParent, `row ${got.row} "${got.title}": parent index ${got.parent} != ${wantParent}`);
      });
    }
  }
  return { problems, stats };
}
