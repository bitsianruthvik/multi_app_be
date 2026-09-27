/**
 * cf_plant_operations.mjs — operations, machine rules, timing formulas, item
 * specs, flows and flow assignment, from the plant's workbook
 * (TM/imports/Process_Flow_v5.xlsx). Run cf_plant_machines.mjs FIRST — this
 * script looks up machine leaves (CNCPLASMA, SAWWELD, …) by the codes that
 * one creates and refuses to run if they are missing.
 *
 * SOURCE, READ AT RUNTIME
 * CG_Master_Stores (31 numbered rows + 2 lettered ones, "A" and "B" — see
 * MASTER_STORES below) is the raw-operation -> grouped-operation table.
 * CG_Flow's 26 data rows each give one composite-girder PART's operation
 * sequence as CG_Master_Stores S.No values, in columns D..AB; this script
 * resolves every row's sequence to operation codes, groups rows that resolve
 * to the IDENTICAL sequence, and prints the whole derivation — flows are
 * DISCOVERED from the workbook, not hand-typed, so a re-extract is checked
 * automatically (a sequence that appears that this script does not recognise
 * fails loudly instead of silently building the wrong flow).
 *
 * TABLE SPECIFICATIONS (rate charts)
 * data_type 'table' and cf_spec_values.value_json exist in this database as
 * of this run (checked below, TABLE_SUPPORTED) — the other agent's half of
 * this plan (CF_ERP_PLAN.md, "production setup from the plant's Process_
 * Flow_v5 workbook", part A) finished first. If it had not, this script
 * still runs: every table spec, its rule and its chart values are skipped
 * with the chart printed instead of written, and the formulas that need
 * LOOKUP() are skipped too (a formula referencing a table that does not
 * exist cannot parse) — everything else (operations, item specs, flows,
 * constants, non-table formulas, flow assignment) is built regardless.
 *
 * OPERATION AND FLOW CODES ARE ALL NEW (CG- PREFIX)
 * The 14 operations and 7 flows cf_ops_import.mjs built (a generic import
 * from fab_erp, being retired below) already use short codes this workbook's
 * own names would collide with — SAW and PAINT are both existing OPERATION
 * codes, for instance. Every code here is prefixed CG- (composite girder) so
 * nothing here can be mistaken for, or silently merged into, the set being
 * replaced. The retirement step checks no live flow or definition still
 * points at an old code before marking it inactive/obsolete.
 *
 * RATES LEFT EMPTY, ON PURPOSE — never invent a number
 *   - Blasting: the sheet asks "job profile?" — area/length basis undefined.
 *   - Line matching: the sheet says "need to confirm".
 *   - The "Welding ?" step (CG_Master_Stores row A): the sheet never names
 *     the process OR the machine ("?" for both).
 *   - Arc welding: Master_Formulae shows the FORM of the formula with an
 *     illustrative, not measured, sample rate — Sample_Calculations has no
 *     arc-welding chart at all.
 *   - Trial assembly: the day -> minute conversion is not given (Sample_
 *     Calculations tables the time in DAYS by span and girder type); the
 *     formula's shape (span, and the below/above-36m multiplier) is real,
 *     the constant is not.
 *   - Dismantling: defined as half of trial assembly's time, which is
 *     itself unresolved.
 *   - Jack bend removal and "Fitup" (bracing gusset/angles): CG_Master_Stores
 *     gives NO machine group for either (a literal "-", and a blank) — the
 *     RATES are known (30 min/m, 240 min/fit-up) but no rule can be written
 *     with no subject to attach it to.
 *
 * STRUCTURE DEPENDENCE
 * Sample_Calculations' SAW and MIG rate charts are given per STRUCTURE (arch,
 * PLB box, I-beam, tie beam, girder, angle), not just weld size. Per the
 * plan: SAW_RATE uses the GIRDER row, MIG_RATE the I-BEAM row (MIG's table
 * has no girder row) — both charts are consequently very sparse (SAW: 2 of 3
 * columns; MIG: 1 of 4). The user decided that composite-girder MIG work uses
 * the workbook's I-beam rate, so MIG_RATE is deliberately that proxy until a
 * plant-specific composite-girder chart is supplied.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_plant_operations.mjs
 *   cd multi_app_be && CF_PLANT_COMPANY=30005 node scripts/cf_kepl/cf_plant_operations.mjs --commit
 *
 * Dry run by default — one transaction, rolled back unless --commit.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const cls = await imp('apps/cf_erp/services/classificationService.js');
const opsSvc = await imp('apps/cf_erp/services/operationService.js');
const flowSvc = await imp('apps/cf_erp/services/flowService.js');
const specSvc = await imp('apps/cf_erp/services/specificationService.js');
const valueSvc = await imp('apps/cf_erp/services/valueService.js');
const ruleSvc = await imp('apps/cf_erp/services/assignmentService.js');
const formulaSvc = await imp('apps/cf_erp/services/formulaService.js');
const { updateRecord } = await imp('apps/cf_erp/services/masterRecordService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? process.env.CF_PLANT_COMPANY ?? 2);
const COMMIT = process.argv.includes('--commit');
const WORKBOOK = path.join(BE, '..', 'imports', 'Process_Flow_v5.xlsx');
const where = /^(localhost|127\.0\.0\.1|::1)?$/i.test(process.env.DB_HOST ?? '') ? 'local' : 'PRODUCTION';
const say = (...a) => console.log(...a);

if (!fs.existsSync(WORKBOOK)) throw new Error(`${WORKBOOK} is missing — this script reads TM/imports/Process_Flow_v5.xlsx directly.`);

// ===========================================================================
// 0. Does data_type 'table' exist yet? (plan part A, built by the other agent)
// ===========================================================================
let TABLE_SUPPORTED = Array.isArray(specSvc.DATA_TYPES) && specSvc.DATA_TYPES.includes('table');
if (TABLE_SUPPORTED) {
  const probe = await pool.query("SHOW COLUMNS FROM cf_specifications LIKE 'table_config'");
  const probe2 = await pool.query("SHOW COLUMNS FROM cf_spec_values LIKE 'value_json'");
  TABLE_SUPPORTED = probe[0].length > 0 && probe2[0].length > 0;
}
say(`${where}, company ${COMPANY} — ${COMMIT ? 'writing operations, flows and rates' : 'dry run: builds it, prints it, rolls back'}`);
say(`table specifications: ${TABLE_SUPPORTED ? 'supported — rate charts will be written' : 'NOT YET SUPPORTED — charts will be printed, not written'}`);

// ===========================================================================
// 1. CG_Master_Stores and CG_Flow, read at runtime
// ===========================================================================
const val = (cell) => {
  if (cell.type === ExcelJS.ValueType.Merge) return val(cell.master);
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    if (v.result !== undefined) return v.result == null ? null : v.result;
    return null;
  }
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(WORKBOOK);

/** S.No (number or "A"/"B") -> grouped operation name, straight off CG_Master_Stores columns A and C. */
function readMasterStores() {
  const ws = wb.getWorksheet('CG_Master_Stores');
  const out = new Map();
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sno = val(row.getCell(1));
    const grouped = val(row.getCell(3));
    if (sno == null || grouped == null) continue;
    out.set(String(sno), grouped);
  }
  return out;
}
const MASTER_STORES = readMasterStores();

/** Every CG_Flow data row: { row, category, part, sequence: [S.No...] }. Category is blank on the four "whole assembly" rows (G11, End/Intermediate Diaphragm, Bottom Lateral Bracing) — merged-cell fallout, not a parsing bug (checked against the raw sheet by hand). */
function readCgFlow() {
  const ws = wb.getWorksheet('CG_Flow');
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const category = val(row.getCell(2));
    const part = val(row.getCell(3));
    const sequence = [];
    for (let c = 4; c <= 28; c++) {
      const v = val(row.getCell(c));
      if (v === null || v === '') continue;
      sequence.push(String(v));
    }
    if (!part) continue;
    out.push({ row: r, category, part, sequence });
  }
  return out;
}
const CG_FLOW_ROWS = readCgFlow();

/** Grouped-operation name (CG_Master_Stores column C) -> this script's operation code. */
const GROUPED_NAME_TO_OP = new Map(Object.entries({
  'CNC Cutting': 'CG-CNCCUT',
  'Gas Cutting': 'CG-GASCUT',
  'H-Beam Fit-up': 'CG-HBFIT',
  'SAW Welding': 'CG-SAWWELD',
  'Jack Bend Removal': 'CG-JACKBEND',
  'Line Matching': 'CG-LINEMATCH',
  'CNC Drilling': 'CG-CNCDRILL',
  'Manual Drilling': 'CG-MANDRILL',
  'Stiffener Fit-up': 'CG-STIFFFIT',
  'MIG Welding': 'CG-MIGWELD',
  'Flip Girders': 'CG-FLIPGIRDER',
  'ID/ED - Fitup': 'CG-IDEDFIT',
  'Arc Welding': 'CG-ARCWELD',
  'Trial Assembly': 'CG-TRIALASM',
  'Dismantling': 'CG-DISMANTLE',
  'Stud Welding': 'CG-STUDWELD',
  'Blasting': 'CG-BLAST',
  'Metallising': 'CG-METALLIZE',
  'Painting': 'CG-PAINT',
  'Fitup': 'CG-BRACEFIT',
  'Dispatch': 'CG-DISPATCH',
  '?': 'CG-WELDTBD',
}));

/** Resolves a CG_Flow row's S.No sequence to operation codes. Throws (not
 *  a silent skip) on an S.No CG_Master_Stores does not have, or a grouped
 *  name this script has not mapped — a re-extract must be looked at, not
 *  quietly built wrong. */
function resolveSequence(row) {
  return row.sequence.map((sno) => {
    const grouped = MASTER_STORES.get(sno);
    if (grouped == null) throw new Error(`CG_Flow row ${row.row} (${row.category || ''} ${row.part}) names CG_Master_Stores S.No "${sno}", which does not exist.`);
    const opCode = GROUPED_NAME_TO_OP.get(grouped);
    if (!opCode) throw new Error(`CG_Flow row ${row.row} (${row.category || ''} ${row.part}): grouped operation "${grouped}" (S.No ${sno}) has no operation code mapped in GROUPED_NAME_TO_OP.`);
    return opCode;
  });
}

// ===========================================================================
// 2. Group CG_Flow's rows into named flows by identical resolved sequence
// ===========================================================================
const resolvedRows = CG_FLOW_ROWS.map((r) => ({ ...r, opSequence: resolveSequence(r) }));
const bySequence = new Map(); // JSON key -> { opSequence, rows: [...] }
for (const r of resolvedRows) {
  const key = JSON.stringify(r.opSequence);
  if (!bySequence.has(key)) bySequence.set(key, { opSequence: r.opSequence, rows: [] });
  bySequence.get(key).rows.push(r);
}

/** Which distinct sequence gets which flow code/name — matched by a
 *  representative (category, part) from the group, so a sequence this
 *  script does not recognise fails loudly (the else-throw below) instead of
 *  silently becoming an unnamed flow. */
function nameFlow(rows) {
  const has = (cat, part) => rows.some((r) => (r.category || '').toLowerCase() === cat && r.part.toLowerCase() === part);
  if (rows.some((r) => r.part === 'G11')) return { code: 'CG-GIRDERASM', name: 'Girder assembly' };
  if (has('girder', 'top flange') || has('girder', 'bottom flange') || has('girder', 'web plate') || has('girder', 'stiffiner (plain)')
    || has('end diaphragm', 'top flange') || has('end diaphragm', 'bottom flange') || has('end diaphragm', 'pad plate')
    || has('intermediate diaphragm', 'top flange') || has('intermediate diaphragm', 'bottom flange') || has('intermediate diaphragm', 'deduct web')) {
    return { code: 'CG-PLATEPART', name: 'Plate part' };
  }
  if (has('girder', 'stiffiner (holes)') || has('end diaphragm', 'web plate') || has('end diaphragm', 'stiffiner plate') || has('intermediate diaphragm', 'web plate')) {
    return { code: 'CG-HOLEDPART', name: 'Holed part' };
  }
  if (has('splice plates', 'tifc') || has('splice plates', 'bifc')) return { code: 'CG-INNERSPLICE', name: 'Inner splice' };
  if (has('splice plates', 'tofc') || has('splice plates', 'bofc') || has('splice plates', 'wcp')) return { code: 'CG-OUTERSPLICE', name: 'Outer splice' };
  if (rows.some((r) => r.part === 'End Diaphragm' || r.part === 'Intermediate Diaphragm')) return { code: 'CG-DIAPHASM', name: 'Diaphragm assembly' };
  if (has('bottom lateral bracing', 'gusset plate')) return { code: 'CG-BRACEGUSSET', name: 'Bracing gusset' };
  if (has('bottom lateral bracing', 'angle (bracing)')) return { code: 'CG-BRACEANGLE', name: 'Bracing angle' };
  if (rows.some((r) => r.part === 'Bottom Lateral Bracing')) return { code: 'CG-BRACEASM', name: 'Bracing assembly' };
  if (has('seismic stopper', 'stiffiner plate') || has('seismic stopper', 'end plate')) return { code: 'CG-SEISMICPART', name: 'Seismic stopper parts' };
  throw new Error(`CG_Flow rows ${rows.map((r) => r.row).join(',')} (${rows[0].category || ''} ${rows[0].part}) resolve to a sequence nameFlow() does not recognise — add it there.`);
}

const FLOWS_FROM_WORKBOOK = [...bySequence.values()].map((g) => ({ ...nameFlow(g.rows), steps: g.opSequence, rows: g.rows }));

/** Not from CG_Flow: a set (splice set / girder line / bridge span) is not a
 *  thing the shop builds — the old cf_assembly_flows.mjs's SET-CHECK reasoning
 *  (a piece that sells or gates material needs a last step, or stockFinished
 *  never fires and expand() drops the whole subtree) still holds; CG_Flow
 *  gives none of the three an assembly-level row at all, so this one flow is
 *  a decision made HERE, not read off the sheet. */
const DISPATCH_ONLY_FLOW = { code: 'CG-DISPATCHONLY', name: 'Dispatch only (a set, not a thing the shop builds)', steps: ['CG-DISPATCH'], rows: [] };
const ALL_FLOWS = [...FLOWS_FROM_WORKBOOK, DISPATCH_ONLY_FLOW];

say(`\n-- CG_Flow: ${CG_FLOW_ROWS.length} part rows -> ${FLOWS_FROM_WORKBOOK.length} distinct flows (+1 decided here, not from the sheet) --`);
for (const f of ALL_FLOWS) {
  say(`   ${f.code.padEnd(16)} ${f.name.padEnd(28)} ${f.steps.length} step(s): ${f.steps.join(' > ')}`);
  for (const r of f.rows) say(`      from row ${r.row}: ${(r.category || '(same as above)').padEnd(22)} ${r.part}`);
}

// ===========================================================================
// 3. Operations (22: the 21 the plan counts, plus CG-WELDTBD — CG_Master_
//    Stores row "A" names a real step in the bracing-assembly sequence whose
//    own process AND machine are both "?" in the source; dropping it would
//    silently shorten that flow by one step)
// ===========================================================================
const OPERATIONS = [
  { code: 'CG-CNCCUT', name: 'CNC Cutting', leaf: 'CNCPLASMA' },
  { code: 'CG-GASCUT', name: 'Gas Cutting', leaf: 'PUGCUT' },
  { code: 'CG-HBFIT', name: 'H-Beam Fit-up', leaf: 'HBEAMLINE' },
  { code: 'CG-SAWWELD', name: 'SAW Welding', leaf: 'SAWWELD' },
  { code: 'CG-JACKBEND', name: 'Jack Bend Removal', leaf: null, machineNote: 'CG_Master_Stores gives "-" for its machine group — none named.' },
  { code: 'CG-LINEMATCH', name: 'Line Matching', leaf: 'EOT' },
  { code: 'CG-CNCDRILL', name: 'CNC Drilling', leaf: 'CNCDRILL' },
  { code: 'CG-MANDRILL', name: 'Manual Drilling', leaf: 'MANDRILL', description: 'Includes hole transfer (marking before drilling) — one operation in this workbook, not two.' },
  { code: 'CG-STIFFFIT', name: 'Stiffener Fit-up', leaf: 'ARC' },
  { code: 'CG-MIGWELD', name: 'MIG Welding', leaf: 'MIGWELD' },
  { code: 'CG-FLIPGIRDER', name: 'Flip Girders', leaf: 'EOT' },
  { code: 'CG-IDEDFIT', name: 'ID/ED Fit-up', leaf: 'ARC', description: 'TF/BF/web fit-up of the end and intermediate diaphragms onto the girder.' },
  { code: 'CG-ARCWELD', name: 'Arc Welding', leaf: 'ARC' },
  { code: 'CG-TRIALASM', name: 'Trial Assembly', leaf: 'GANTRY' },
  { code: 'CG-DISMANTLE', name: 'Dismantling', leaf: 'GANTRY' },
  { code: 'CG-STUDWELD', name: 'Stud Welding', leaf: 'STUD' },
  { code: 'CG-BLAST', name: 'Blasting', leaf: 'AUTOBLAST' },
  { code: 'CG-METALLIZE', name: 'Metallising', leaf: 'METALGUN' },
  { code: 'CG-PAINT', name: 'Painting', leaf: 'PAINTGUN' },
  { code: 'CG-BRACEFIT', name: 'Fit-up (bracing gusset/angles)', leaf: null, machineNote: 'CG_Master_Stores names no machine group at all for this row.' },
  { code: 'CG-DISPATCH', name: 'Dispatch', leaf: 'HYDRA' },
  { code: 'CG-WELDTBD', name: 'Welding (process not specified)', leaf: null, machineNote: 'CG_Master_Stores\' own row: raw operation "Welding", grouped operation "?", machine "?" — the sheet never resolved what this step is.' },
];

// ===========================================================================
// 4. Timing — a formula (kind 'formula'), a flat constant (kind 'constant'),
//    or left EMPTY (kind 'none', with why). needsTable formulas are skipped
//    when TABLE_SUPPORTED is false; their chart is still printed (step 6).
// ===========================================================================
const TIMING = {
  'CG-CNCCUT': { kind: 'formula', code: 'CG_CNC_CUT_TIME', expr: 'item.CUT_LENGTH / LOOKUP(machine.CUT_SPEED, item.THICKNESS) + item.PIERCINGS * machine.PIERCE_TIME / 60', needsTable: true },
  'CG-GASCUT': { kind: 'formula', code: 'CG_GAS_CUT_TIME', expr: 'item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS)', needsTable: true },
  'CG-HBFIT': { kind: 'formula', code: 'CG_HBEAM_FITUP_TIME', expr: '133 * item.LENGTH / 19000', note: 'R_hfit=133 min per 19 m reference length; the sample calc uses setup 0 — the sheet\'s separate "60 min setup" note is a question for the user.' },
  'CG-SAWWELD': { kind: 'formula', code: 'CG_SAW_WELD_TIME', expr: 'item.WELD_LENGTH * LOOKUP(machine.SAW_RATE, item.WELD_SIZE)', needsTable: true },
  'CG-JACKBEND': { kind: 'none', note: 'rate known (30 min/m, 12 h shift / 24 m) but no machine group named in the sheet to attach a rule to.' },
  'CG-LINEMATCH': { kind: 'none', note: 'rate "need to confirm" in the sheet — the machine (EOT crane) is known, so an eligibility rule is written with no work time.', eligibleOnly: true },
  'CG-CNCDRILL': { kind: 'formula', code: 'CG_CNC_DRILL_TIME', expr: 'item.HOLES * LOOKUP(machine.DRILL_TIME, item.THICKNESS, item.HOLE_DIA) / 60', needsTable: true },
  'CG-MANDRILL': { kind: 'formula', code: 'CG_MANUAL_DRILL_TIME', expr: 'item.HOLES * machine.MANUAL_DRILL_TIME + item.HOLE_TRANSFERS * machine.MARK_TIME' },
  'CG-STIFFFIT': { kind: 'formula', code: 'CG_STIFFENER_FITUP_TIME', expr: 'item.STIFFENERS * 20', note: 'the sheet says 15-20 min per stiffener; 20 taken, on the record.' },
  'CG-MIGWELD': { kind: 'formula', code: 'CG_MIG_WELD_TIME', expr: 'item.WELD_LENGTH * LOOKUP(machine.MIG_RATE, item.WELD_SIZE)', needsTable: true },
  'CG-FLIPGIRDER': { kind: 'constant', workMinutes: 30 },
  'CG-IDEDFIT': { kind: 'constant', workMinutes: 180 },
  'CG-ARCWELD': { kind: 'formula', code: 'CG_ARC_WELD_TIME', expr: 'item.WELD_LENGTH * LOOKUP(machine.ARC_RATE, item.WELD_SIZE)', needsTable: true, chartEmpty: true, note: 'Sample_Calculations has no measured arc-welding chart — the table is created with no rows, so this always reports "rate not set".' },
  'CG-TRIALASM': { kind: 'none', note: 'the day -> minute conversion is not given (the sheet tables the time in DAYS, by span and by girder type); the span/36 and girder-type dependence is real but the constant is not.' },
  'CG-DISMANTLE': { kind: 'none', note: 'defined as 0.5 x trial assembly time, which is itself unresolved.' },
  'CG-STUDWELD': { kind: 'formula', code: 'CG_STUD_WELD_TIME', expr: 'item.STUDS * machine.STUD_TIME / 60' },
  'CG-BLAST': { kind: 'none', note: 'the sheet asks "job profile?" — area/length basis and coat count are undefined. The machine (automatic blasting) is known.', eligibleOnly: true },
  'CG-METALLIZE': { kind: 'formula', code: 'CG_METALLIZE_TIME', expr: 'item.SURFACE_AREA * machine.METAL_RATE * item.COATS' },
  'CG-PAINT': { kind: 'formula', code: 'CG_PAINT_TIME', expr: 'item.SURFACE_AREA * machine.PAINT_RATE * item.COATS' },
  'CG-BRACEFIT': { kind: 'none', note: 'rate known (240 min per fit-up, "X-frame fit-up", 12 h shift / 3) but no machine group named in the sheet.' },
  'CG-DISPATCH': { kind: 'none', note: 'no rate given in the sheet for dispatch/handling time.', eligibleOnly: true },
  'CG-WELDTBD': { kind: 'none', note: 'the sheet never names the process or the machine ("Welding" / "?" / "?").' },
};

// ===========================================================================
// 5. Machine specs: constants (plain numbers) and rate-chart tables
// ===========================================================================
const MACHINE_CONSTANTS = [
  { code: 'PIERCE_TIME', name: 'Piercing time', dataType: 'number', decimals: 2, defaultUom: 's', leaf: 'CNCPLASMA', value: 3 },
  { code: 'MANUAL_DRILL_TIME', name: 'Manual drilling time per hole', dataType: 'number', decimals: 2, defaultUom: 'min', leaf: 'MANDRILL', value: 2.5, note: 'sheet says 2-2.5 min per hole; 2.5 (the upper bound) taken, same pattern as stiffener fit-up.' },
  { code: 'MARK_TIME', name: 'Marking time per hole transfer', dataType: 'number', decimals: 2, defaultUom: 'min', leaf: 'MANDRILL', value: 0.5 },
  { code: 'STUD_TIME', name: 'Stud weld time', dataType: 'number', decimals: 2, defaultUom: 's', leaf: 'STUD', value: 25, note: 'pick + place + weld, one cycle.' },
  { code: 'METAL_RATE', name: 'Metallising rate', dataType: 'number', decimals: 2, defaultUom: 'min/m2', leaf: 'METALGUN', value: 3.3 },
  { code: 'PAINT_RATE', name: 'Painting rate', dataType: 'number', decimals: 2, defaultUom: 'min/m2', leaf: 'PAINTGUN', value: 0.5 },
];

/** Rate charts. `at`: 'leaf' (one shared chart, a 'defaulted' rule) or
 *  'machine' (each machine enters its own, an 'entered' rule — only CNC
 *  cutting differs machine to machine in this workbook). Values from
 *  Sample_Calculations, cited row by row; x/y are chart axis values,
 *  never invented between what the sheet gives. */
const THICKNESS_AXIS = [6, 8, 12, 16, 18, 20, 22, 25, 28, 30, 32, 36, 40, 45, 50];
const MACHINE_TABLES = [
  {
    code: 'CUT_SPEED', name: 'Cutting speed', axes: [{ label: 'Thickness', unit: 'mm' }], defaultUom: 'mm/min', at: 'machine', leaf: 'CNCPLASMA',
    values: [
      { machineCode: 'PFPL/CNCP/01', x: THICKNESS_AXIS, v: [3535, 2860, 1700, 1515, 1277, 1075, 915, 665, 945, 783, 635, 862, 660, 494, 295] },
      { machineCode: 'PFPL/CNCP/02', x: THICKNESS_AXIS, v: [3735, 3060, 1900, 1715, 1477, 1275, 1115, 865, 1145, 983, 835, 1062, 860, 694, 495] },
    ],
    note: 'CNC-2 is CNC-1 + 200 mm/min at every thickness, exactly, in the sheet\'s own rows. Not monotonic falling past 25mm and 32mm — kept exactly as the sheet gives it.',
  },
  {
    code: 'GAS_CUT_SPEED', name: 'Gas cutting speed', axes: [{ label: 'Thickness', unit: 'mm' }], defaultUom: 'mm/min', at: 'leaf', leaf: 'PUGCUT',
    values: [{ x: THICKNESS_AXIS, v: [650, 550, 520, 490, 480, 460, 450, 440, 420, 400, 385, 370, 350, 330, 320] }],
  },
  {
    code: 'DRILL_TIME', name: 'CNC drilling time', axes: [{ label: 'Thickness', unit: 'mm' }, { label: 'Hole diameter', unit: 'mm' }], defaultUom: 's', at: 'leaf', leaf: 'CNCDRILL',
    values: [{
      x: [10, 20, 30, 40, 50, 60, 70],
      y: [14, 21, 23, 25, 26, 35, 45, 60],
      v: [
        [null, null, null, null, null, null, null], // 14mm: "x" in the sheet — cannot
        [50, 80, 110, 180, 240, 270, 300],            // 21mm: measured
        [null, null, null, null, null, null, null], // 23mm: "..", not measured
        [null, null, null, null, null, null, null], // 25mm: "..", not measured
        [55, 100, 120, 210, 270, 330, 360],            // 26mm: measured
        [null, null, null, null, null, null, null], // 35mm: "x"
        [null, null, null, null, null, null, null], // 45mm: "x"
        [null, null, null, null, null, null, null], // 60mm: "x"
      ],
    }],
    note: '23mm and 25mm are unmeasured. Keep their null rows so step_up cannot silently substitute the 26mm rate.',
  },
  {
    code: 'SAW_RATE', name: 'SAW welding rate (girder)', axes: [{ label: 'Weld size', unit: 'mm' }], defaultUom: 'min/m', at: 'leaf', leaf: 'SAWWELD',
    values: [{ x: [6, 10, 12], v: [200 / 60, null, 350 / 60] }],
    note: 'Girder row: Route(3-6mm)=200s at x=6, Fillup(10mm) remains blank, Fillup(10-12mm)=350s at x=12. Structure-dependent — see the header.',
  },
  {
    code: 'MIG_RATE', name: 'MIG welding rate (I-beam)', axes: [{ label: 'Weld size', unit: 'mm' }], defaultUom: 'min/m', at: 'leaf', leaf: 'MIGWELD',
    values: [{ x: [8, 10, 12], v: [null, null, 15] }],
    note: 'I-beam row: 8mm and 10mm are "-" (cannot) in the sheet, 12mm=15 min/m is the only measured point, 16mm is blank (excluded). Structure-dependent — see the header.',
  },
  {
    code: 'ARC_RATE', name: 'Arc welding rate', axes: [{ label: 'Weld size', unit: 'mm' }], defaultUom: 'min/m', at: 'leaf', leaf: 'ARC',
    values: [], // deliberately empty — see TIMING['CG-ARCWELD']
    note: 'no chart in Sample_Calculations at all — created with no rows, so LOOKUP always reports "rate not set".',
  },
];

// ===========================================================================
// 6. Item specs the formulas read
// ===========================================================================
const ITEM_SPECS = [
  { code: 'CUT_LENGTH', name: 'Cut length', dataType: 'number', decimals: 2, defaultUom: 'mm', node: 'PLATE_PART', note: 'from the nesting — entered here; a nesting-side writer can populate it the same way it will populate dimensions.' },
  { code: 'PIERCINGS', name: 'Piercings', dataType: 'number', decimals: 0, node: 'PLATE_PART', note: 'from the nesting.' },
  { code: 'WELD_LENGTH', name: 'Weld length', dataType: 'number', decimals: 3, defaultUom: 'm', node: 'FAB_ASSY', note: 'METRES, not mm like LENGTH/THICKNESS — the rate charts are min/m, and the plan\'s own formula (item.WELD_LENGTH * LOOKUP(...)) has no unit conversion in it.' },
  { code: 'WELD_SIZE', name: 'Weld size', dataType: 'number', decimals: 1, defaultUom: 'mm', node: 'FAB_ASSY' },
  { code: 'HOLES', name: 'Holes', dataType: 'number', decimals: 0, node: 'PLATE_PART' },
  { code: 'HOLE_DIA', name: 'Hole diameter', dataType: 'number', decimals: 1, defaultUom: 'mm', node: 'PLATE_PART' },
  { code: 'HOLE_TRANSFERS', name: 'Hole transfers', dataType: 'number', decimals: 0, node: 'PLATE_PART', note: 'how many holes are match-marked before drilling, feeding the manual-drilling formula\'s marking-time term.' },
  { code: 'STIFFENERS', name: 'Stiffeners', dataType: 'number', decimals: 0, node: 'FAB_ASSY', note: 'entered, not a roll-up: HOLED (the only spec that would tell plain from drilled) is a rule on the whole FAB_PARTS family, so COUNT(HOLED) would count every part, not only stiffeners — there is no classification that means "stiffener" on its own to roll up over.' },
  { code: 'JOINTS', name: 'Joints', dataType: 'number', decimals: 0, node: 'FAB_ASSY', note: 'feeds line matching, whose rate is unresolved (see TIMING).' },
  { code: 'SURFACE_AREA', name: 'Surface area', dataType: 'number', decimals: 3, defaultUom: 'm2', node: 'PLATE_PART', calculated: { formula: 'CG_SURFACE_AREA', expr: 'LENGTH * WIDTH / 1e6' } },
  { code: 'COATS', name: 'Coats', dataType: 'number', decimals: 0, node: 'FAB_ASSY' },
  { code: 'STUDS', name: 'Studs', dataType: 'number', decimals: 0, node: 'FAB_ASSY', note: 'entered, not a roll-up — same reasoning as STIFFENERS: nothing in the KEPL catalog\'s BOM shape identifies a stud line to sum over.' },
  { code: 'GIRDER_TYPE', name: 'Girder type', dataType: 'option', node: 'FAB_ASSY', options: [{ value: 'composite', label: 'Composite' }, { value: 'bowstring', label: 'Bowstring' }, { value: 'open_web', label: 'Open web' }, { value: 'tub', label: 'Tub' }], note: 'informational — Stage_Wise_Variables gives a different trial-assembly day-count per type, but with the day->minute conversion unresolved this cannot yet feed a formula (LOOKUP axes must be numbers, and girder type is not one).' },
];
/** Assembly roll-up of the plate parts' own calculated area — same pattern as
 *  the existing ASSEMBLY_WEIGHT (SUM(children.WEIGHT)). A real simplification:
 *  it ignores shape/complexity factors a true paint-area estimate would need. */
const ASSY_SURFACE_AREA_FORMULA = { code: 'CG_ASSY_SURFACE_AREA', expr: 'SUM(children.SURFACE_AREA)' };

// ===========================================================================
// 7. Definition -> flow assignment (company's existing template definitions,
//    matched by classification and by code/name — never guessed)
// ===========================================================================
const DEFINITION_FLOW_BY_CLASS = [
  { classCode: 'PLATE_PART', flow: 'CG-PLATEPART', note: 'default for every plate-part definition (flanges, webs, plain stiffeners).' },
  { classCode: 'GIRDER_SEGMENT', flow: 'CG-GIRDERASM' },
  { classCode: 'DIAPHRAGM', flow: 'CG-DIAPHASM' },
  { classCode: 'SPLICE_SET', flow: 'CG-DISPATCHONLY', note: 'a set, not a thing the shop builds.' },
  { classCode: 'GIRDER_LINE', flow: 'CG-DISPATCHONLY', note: 'a set, not a thing the shop builds.' },
  { classCode: 'BRIDGE_SPAN', flow: 'CG-DISPATCHONLY', note: 'a set, not a thing the shop builds.' },
  { classCode: 'BRACING_GUSSET', flow: 'CG-BRACEGUSSET' },
  { classCode: 'BRACING_ANGLE', flow: 'CG-BRACEANGLE' },
  { classCode: 'BRACING_ASSEMBLY', flow: 'CG-BRACEASM' },
  { classCode: 'SEISMIC_STOPPER', flow: 'CG-SEISMICPART' },
];
/** Overrides by definition CODE PREFIX, applied after the class default —
 *  a specific definition that is not the plain/default case for its class. */
const DEFINITION_FLOW_BY_CODE = [
  { prefix: 'DWB-', flow: 'CG-HOLEDPART', note: 'diaphragm web plate is always drilled per CG_Flow (S12/S18) — not the plain default.' },
  { prefix: 'CP-', flow: 'CG-OUTERSPLICE', note: 'matched to WCP (Web Cover Plate) by name — CG_Flow\'s outer-splice sequence.' },
];
/** Definitions this script deliberately leaves UNMATCHED — printed, never guessed. */
const DEFINITION_FLOW_UNMATCHED_CODES = new Map([
  ['SP-', 'ambiguous among the 5 splice-plate kinds CG_Flow gives (TIFC/BIFC = inner splice; TOFC/BOFC/WCP = outer splice) — this one generic "Splice plate" definition cannot be all of them. Needs the user to say which, or split it.'],
]);

// ===========================================================================
// Build
// ===========================================================================
const tally = { created: {}, reused: {}, skipped: {} };
const bump = (bag, k, n = 1) => { bag[k] = (bag[k] ?? 0) + n; };
const notes = [];
const questions = [];

async function leafNode(db, companyId, leafCode) {
  const [[row]] = await db.query("SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND scope = 'machine' AND deleted_at IS NULL", [companyId, leafCode]);
  return row ?? null;
}
async function classNode(db, companyId, classCode) {
  const [[row]] = await db.query("SELECT id, code, name FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND scope <> 'machine' AND deleted_at IS NULL", [companyId, classCode]);
  return row ?? null;
}
async function machineByCode(db, companyId, code) {
  const [[row]] = await db.query('SELECT id, code FROM cf_machines WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [companyId, code]);
  return row ?? null;
}

async function ensureOperation(db, c, def) {
  const [[row]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code]);
  if (row) { bump(tally.reused, 'operation'); return row.id; }
  const description = [def.description, def.machineNote].filter(Boolean).join(' ') || undefined;
  const o = await opsSvc.createOperation(db, c, { code: def.code, name: def.name, description, status: 'active' });
  bump(tally.created, 'operation');
  return o.id;
}

async function ensureSpec(db, c, def) {
  const [[row]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, def.code]);
  if (row) { bump(tally.reused, 'specification'); return row.id; }
  const s = await specSvc.createSpec(db, c, def);
  bump(tally.created, 'specification');
  return s.id;
}

async function ensureFormula(db, c, code, expression, description) {
  const [[row]] = await db.query('SELECT id FROM cf_formulas WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, code]);
  if (row) { bump(tally.reused, 'formula'); return row.id; }
  const f = await formulaSvc.createFormula(db, c, { code, name: code.replace(/_/g, ' ').toLowerCase(), expression, description, status: 'active' });
  bump(tally.created, 'formula');
  return f.id;
}

async function ensureSpecRule(db, c, subjectId, specId, body) {
  const existing = await ruleSvc.listRules(db, c.companyId, 'classification', subjectId);
  const have = existing.find((r) => r.specificationId === specId && r.captureAt === 'item');
  if (have) { bump(tally.reused, 'spec rule'); return have.id; }
  const r = await ruleSvc.createRule(db, c, { subjectType: 'classification', subjectId, specificationId: specId, captureAt: 'item', ...body });
  bump(tally.created, 'spec rule');
  return r.id;
}

async function ensureClassificationValue(db, c, nodeId, specCode, value) {
  const out = await valueSvc.setValues(db, c, 'classification', nodeId, [{ specCode, value }]);
  if (out.changes.length) bump(tally.created, 'classification value');
  else bump(tally.reused, 'classification value');
}
async function ensureMachineValue(db, c, machineId, specCode, value) {
  const out = await valueSvc.setValues(db, c, 'machine', machineId, [{ specCode, value }]);
  if (out.changes.length) bump(tally.created, 'machine value');
  else bump(tally.reused, 'machine value');
}

async function ensureTimingRule(db, c, operationId, subjectType, subjectId, body) {
  const existing = await opsSvc.listTimingRules(db, c.companyId, operationId);
  const have = existing.find((r) => r.subject.type === subjectType && r.subject.id === subjectId);
  if (have) { bump(tally.reused, 'timing rule'); return have.id; }
  const r = await opsSvc.createTimingRule(db, c, operationId, { subjectType, subjectId, eligible: true, ...body });
  bump(tally.created, 'timing rule');
  return r.id;
}

async function ensureFlow(db, c, flowDef) {
  const [[row]] = await db.query('SELECT id, status FROM cf_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, flowDef.code]);
  let flowId = row?.id;
  if (row) bump(tally.reused, 'flow');
  else {
    const f = await flowSvc.createFlow(db, c, { code: flowDef.code, name: flowDef.name, description: `From CG_Flow: ${flowDef.steps.join(' > ')}.` });
    flowId = f.id;
    bump(tally.created, 'flow');
  }
  const [existingSteps] = await db.query(
    `SELECT s.id, s.sequence, o.code AS op_code FROM cf_operation_flow_steps s JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.flow_id = ? AND s.deleted_at IS NULL ORDER BY s.sequence`,
    [c.companyId, flowId],
  );
  const haveKey = new Set(existingSteps.map((s) => `${s.sequence}:${s.op_code}`));
  for (const [i, opCode] of flowDef.steps.entries()) {
    const sequence = (i + 1) * 10;
    if (haveKey.has(`${sequence}:${opCode}`)) { bump(tally.reused, 'flow step'); continue; }
    const [[op]] = await db.query('SELECT id FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [c.companyId, opCode]);
    if (!op) throw new Error(`flow ${flowDef.code} step ${sequence}: operation ${opCode} does not exist.`);
    await flowSvc.addStep(db, c, flowId, { operationId: op.id, sequence });
    bump(tally.created, 'flow step');
  }
  const [[state]] = await db.query('SELECT status FROM cf_operation_flows WHERE company_id = ? AND id = ?', [c.companyId, flowId]);
  if (state.status !== 'active') {
    await flowSvc.setFlowStatus(db, c, flowId, 'active');
    bump(tally.created, 'flow activated');
  }
  return flowId;
}

let conn;
try {
  conn = await pool.getConnection();
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: Number(process.env.CF_PLANT_USER ?? user?.id) };
  if (!c.userId) throw new Error(`no user found for company ${COMPANY} — set CF_PLANT_USER.`);

  // Fail fast, with a clear message, if cf_plant_machines.mjs has not run yet.
  const neededLeaves = [...new Set([...OPERATIONS.map((o) => o.leaf).filter(Boolean), ...MACHINE_CONSTANTS.map((m) => m.leaf), ...MACHINE_TABLES.map((t) => t.leaf)])];
  const leafIds = {};
  for (const code of neededLeaves) {
    const n = await leafNode(conn, COMPANY, code);
    if (!n) throw new Error(`machine leaf "${code}" does not exist — run cf_plant_machines.mjs first (without --commit is fine, but this script needs it committed to find the tree; run cf_plant_machines.mjs --commit before this one).`);
    leafIds[code] = n.id;
  }

  say('\n-- operations --');
  const opId = {};
  for (const o of OPERATIONS) opId[o.code] = await ensureOperation(conn, c, o);
  say(`   ${OPERATIONS.length} operations`);

  say('\n-- item specs --');
  const specId = {};
  for (const s of ITEM_SPECS) {
    specId[s.code] = await ensureSpec(conn, c, { code: s.code, name: s.name, dataType: s.dataType, decimals: s.decimals, defaultUom: s.defaultUom, options: s.options, description: s.note });
  }
  // Rules: entered specs on their node; SURFACE_AREA calculated/rollup.
  const surfaceAreaFormulaId = await ensureFormula(conn, c, 'CG_SURFACE_AREA', 'LENGTH * WIDTH / 1e6', 'A plate\'s surface area from its own sizes.');
  const assySurfaceFormulaId = await ensureFormula(conn, c, ASSY_SURFACE_AREA_FORMULA.code, ASSY_SURFACE_AREA_FORMULA.expr, 'An assembly\'s paintable area, from its plate parts\' own — a real simplification (no shape/complexity factor).');
  for (const s of ITEM_SPECS) {
    const node = await classNode(conn, COMPANY, s.node);
    if (!node) { notes.push(`item spec ${s.code}: classification ${s.node} does not exist in company ${COMPANY} — rule not attached.`); continue; }
    if (s.code === 'SURFACE_AREA') {
      await ensureSpecRule(conn, c, node.id, specId[s.code], { valueRule: 'calculated', formulaId: surfaceAreaFormulaId, sortOrder: 70 });
      const assy = await classNode(conn, COMPANY, 'FAB_ASSY');
      if (assy) await ensureSpecRule(conn, c, assy.id, specId[s.code], { valueRule: 'rollup', formulaId: assySurfaceFormulaId, sortOrder: 70 });
      continue;
    }
    await ensureSpecRule(conn, c, node.id, specId[s.code], { valueRule: 'entered', sortOrder: 40 });
  }
  // Reused, not re-created: LENGTH on FAB_ASSY (H-beam fit-up/jack-bend-removal
  // formulas need an assembly's own length), SPAN_LENGTH on FAB_ASSY inherited
  // from the BOM parent (a girder segment's span is its structure's span).
  {
    const [[lengthSpec]] = await conn.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'LENGTH' AND deleted_at IS NULL", [COMPANY]);
    const [[spanSpec]] = await conn.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'SPAN_LENGTH' AND deleted_at IS NULL", [COMPANY]);
    const assy = await classNode(conn, COMPANY, 'FAB_ASSY');
    if (lengthSpec && assy) await ensureSpecRule(conn, c, assy.id, lengthSpec.id, { valueRule: 'entered', sortOrder: 15 });
    else notes.push('LENGTH and/or FAB_ASSY not found — could not add the assembly-level LENGTH rule the H-beam fit-up formula needs.');
    if (spanSpec && assy) await ensureSpecRule(conn, c, assy.id, spanSpec.id, { valueRule: 'inherited', sortOrder: 16 });
    else notes.push('SPAN_LENGTH and/or FAB_ASSY not found — could not add the inherited SPAN_LENGTH rule (reused instead of a new "SPAN" spec — see the report).');
  }
  say(`   ${ITEM_SPECS.length} item specs (SPAN reused as the existing SPAN_LENGTH, not created new)`);

  say('\n-- machine constants --');
  for (const m of MACHINE_CONSTANTS) {
    const id = await ensureSpec(conn, c, { code: m.code, name: m.name, dataType: m.dataType, decimals: m.decimals, defaultUom: m.defaultUom, description: m.note });
    await ensureSpecRule(conn, c, leafIds[m.leaf], id, { valueRule: 'defaulted', sortOrder: 50 });
    await ensureClassificationValue(conn, c, leafIds[m.leaf], m.code, m.value);
    say(`   ${m.code.padEnd(20)} = ${m.value} ${m.defaultUom ?? ''} on ${m.leaf}`);
  }

  say(`\n-- rate charts ${TABLE_SUPPORTED ? '(writing)' : '(TABLE TYPE NOT AVAILABLE — printing only)'} --`);
  for (const t of MACHINE_TABLES) {
    say(`   ${t.code} — ${t.name} — axes: ${t.axes.map((a) => `${a.label} (${a.unit})`).join(' x ')}${t.note ? `\n      ${t.note}` : ''}`);
    for (const v of t.values) {
      const target = v.machineCode ? `machine ${v.machineCode}` : `leaf ${t.leaf} (shared)`;
      if (v.y) say(`      ${target}: x=[${v.x.join(',')}] y=[${v.y.join(',')}] v=${JSON.stringify(v.v)}`);
      else say(`      ${target}: x=[${v.x.join(',')}] v=[${v.v.map((n) => (n == null ? 'null' : Number(n.toFixed(4)))).join(',')}]`);
    }
    if (!t.values.length) say(`      (no chart rows given in the workbook)`);
    if (!TABLE_SUPPORTED) { bump(tally.skipped, 'rate chart'); continue; }
    const id = await ensureSpec(conn, c, { code: t.code, name: t.name, dataType: 'table', tableConfig: { axes: t.axes, mode: 'step_up' }, defaultUom: t.defaultUom, description: t.note });
    await ensureSpecRule(conn, c, leafIds[t.leaf], id, { valueRule: t.at === 'machine' ? 'entered' : 'defaulted', sortOrder: 60 });
    for (const v of t.values) {
      const value = v.y ? { x: v.x, y: v.y, v: v.v } : { x: v.x, v: v.v };
      if (v.machineCode) {
        const m = await machineByCode(conn, COMPANY, v.machineCode);
        if (!m) { notes.push(`${t.code}: machine ${v.machineCode} not found — chart not written for it.`); continue; }
        await ensureMachineValue(conn, c, m.id, t.code, value);
      } else {
        await ensureClassificationValue(conn, c, leafIds[t.leaf], t.code, value);
      }
    }
  }

  say('\n-- timing formulas and machine rules --');
  for (const op of OPERATIONS) {
    const t = TIMING[op.code];
    const operationId = opId[op.code];
    if (!op.leaf) {
      questions.push(`${op.code} (${op.name}): ${op.machineNote} ${t?.note ?? ''}`.trim());
      continue;
    }
    if (t.kind === 'formula' && t.needsTable && !TABLE_SUPPORTED) {
      notes.push(`${op.code}: formula ${t.code} needs LOOKUP() over a table spec, not available yet — skipped. Expression: ${t.expr}`);
      await ensureTimingRule(conn, c, operationId, 'classification', leafIds[op.leaf], {});
      continue;
    }
    let workFormulaId = null;
    let workMinutes = null;
    if (t.kind === 'formula') {
      workFormulaId = await ensureFormula(conn, c, t.code, t.expr, t.note);
    } else if (t.kind === 'constant') {
      workMinutes = t.workMinutes;
    } else if (t.note) {
      questions.push(`${op.code} (${op.name}): ${t.note}`);
    }
    await ensureTimingRule(conn, c, operationId, 'classification', leafIds[op.leaf], { workFormulaId, workMinutes });
    say(`   ${op.code.padEnd(16)} -> ${op.leaf.padEnd(12)} ${t.kind === 'formula' ? t.code : t.kind === 'constant' ? `${t.workMinutes} min (constant)` : 'rate not set'}`);
  }

  say('\n-- flows --');
  const flowId = {};
  for (const f of ALL_FLOWS) flowId[f.code] = await ensureFlow(conn, c, f);
  say(`   ${ALL_FLOWS.length} flows`);

  say('\n-- definition -> flow assignment --');
  const [templateDefs] = await conn.query(
    `SELECT m.id, m.code, m.name, m.default_flow_id, n.code AS class_code
       FROM cf_master_records m
       JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
       JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL ORDER BY n.code, m.code`,
    [COMPANY],
  );
  const assigned = [];
  const unmatched = [];
  for (const def of templateDefs) {
    let target = null;
    let why = '';
    const codeOverride = DEFINITION_FLOW_BY_CODE.find((o) => def.code.startsWith(o.prefix));
    const unmatchedNote = [...DEFINITION_FLOW_UNMATCHED_CODES.entries()].find(([prefix]) => def.code.startsWith(prefix));
    if (unmatchedNote) {
      unmatched.push(`${def.code} ${def.name}: ${unmatchedNote[1]}`);
      continue;
    }
    if (codeOverride) { target = codeOverride.flow; why = codeOverride.note; }
    else {
      const classMatch = DEFINITION_FLOW_BY_CLASS.find((m) => m.classCode === def.class_code);
      if (classMatch) { target = classMatch.flow; why = classMatch.note ?? ''; }
    }
    if (!target) { unmatched.push(`${def.code} ${def.name} (class ${def.class_code}): no rule matches this classification — left as-is.`); continue; }
    const wantId = flowId[target];
    if (Number(def.default_flow_id) === Number(wantId)) { bump(tally.reused, 'definition flow'); assigned.push(`${def.code.padEnd(10)} ${def.name.padEnd(28)} -> ${target} (already set)`); continue; }
    await updateRecord(conn, c, def.id, { defaultFlowId: wantId });
    bump(tally.created, 'definition flow');
    assigned.push(`${def.code.padEnd(10)} ${def.name.padEnd(28)} -> ${target}${why ? `  (${why})` : ''}`);
  }
  for (const line of assigned) say(`   ${line}`);
  if (unmatched.length) {
    say(`\n   ${unmatched.length} definition(s) NOT matched (left as-is, printed for review):`);
    for (const line of unmatched) say(`     ${line}`);
  }
  // Missing classes: flows built for a kind of part this company has no
  // definitions for yet (bracing, seismic stopper) — say so, not silence.
  const classesPresent = new Set(templateDefs.map((d) => d.class_code));
  for (const m of DEFINITION_FLOW_BY_CLASS) {
    if (!classesPresent.has(m.classCode)) notes.push(`flow ${m.flow}: no "${m.classCode}" classification/definitions exist in company ${COMPANY} yet — the flow is built but unused.`);
  }

  say('\n-- BOM-line override: the drilled intermediate stiffener --');
  // GS-002's Standard BOM carries the SAME IS-002 definition twice, told apart
  // only by the BOM LINE's role text ("... - plain" / "... - drilled") — real
  // structure discovered in the catalog, not order-instance data. The line
  // whose role says "drilled" gets the holed-part flow directly on the line;
  // the plain one is left to inherit IS-002's own default (CG-PLATEPART).
  const [drilledLines] = await conn.query(
    `SELECT bl.id, bl.role, bl.operation_flow_id, dm.code AS parent_code
       FROM cf_bom_lines bl
       JOIN cf_boms b ON b.id = bl.bom_id AND b.deleted_at IS NULL
       JOIN cf_master_records dm ON dm.id = b.parent_id
       JOIN cf_definition_details dd ON dd.company_id = dm.company_id AND dd.master_id = dm.id AND dd.definition_type = 'template' AND dd.deleted_at IS NULL
       JOIN cf_master_records child ON child.company_id = bl.company_id AND child.id = bl.child_id AND child.deleted_at IS NULL
      WHERE bl.company_id = ? AND bl.deleted_at IS NULL AND dm.code = 'GS-002' AND child.code = 'IS-002'
        AND b.bom_type = 'template' AND LOWER(bl.role) LIKE '%drilled%'`,
    [COMPANY],
  );
  if (!drilledLines.length) {
    notes.push('no BOM line with "drilled" in its role text found — the plain/drilled stiffener override was not applied (nothing to apply it to, or the KEPL catalog names it differently).');
  }
  for (const line of drilledLines) {
    if (Number(line.operation_flow_id) === Number(flowId['CG-HOLEDPART'])) { bump(tally.reused, 'bom line flow'); continue; }
    await conn.query('UPDATE cf_bom_lines SET operation_flow_id = ? WHERE company_id = ? AND id = ?', [flowId['CG-HOLEDPART'], COMPANY, line.id]);
    bump(tally.created, 'bom line flow');
    say(`   ${line.parent_code} BOM line ${line.id} ("${line.role}") -> CG-HOLEDPART`);
  }

  say('\n-- retiring the old generic operations and flows --');
  const OLD_OPERATIONS = ['ASSY', 'BLAST', 'CRNMV', 'CRNTN', 'Cut', 'DRILL', 'EDGEP', 'FQC', 'METAL', 'PAINT', 'PQC', 'SAW', 'TUG', 'WQC'];
  const OLD_FLOWS = ['CUTTING', 'DIAPH-FAB', 'LINESEG-FAB', 'PARTFAB-DRILLED', 'PARTFAB-PLAIN', 'PEB-BUILTUP', 'SET-CHECK'];
  let retiredFlows = 0;
  let stillUsed = 0;
  for (const code of OLD_FLOWS) {
    const [[f]] = await conn.query('SELECT id, status FROM cf_operation_flows WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (!f || f.status === 'obsolete') continue;
    const [[{ n }]] = await conn.query(
      `SELECT (SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND default_flow_id = ? AND deleted_at IS NULL)
            + (SELECT COUNT(*) FROM cf_bom_lines WHERE company_id = ? AND operation_flow_id = ? AND deleted_at IS NULL) AS n`,
      [COMPANY, f.id, COMPANY, f.id]);
    if (Number(n)) { stillUsed++; notes.push(`flow ${code}: still used by ${n} record(s) or BOM override(s) — left active.`); continue; }
    await flowSvc.setFlowStatus(conn, c, f.id, 'obsolete');
    retiredFlows++;
  }
  let retiredOps = 0;
  for (const code of OLD_OPERATIONS) {
    const [[o]] = await conn.query('SELECT id, status FROM cf_operations WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (!o || o.status === 'inactive') continue;
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM cf_operation_flow_steps s
        JOIN cf_operation_flows f ON f.company_id = s.company_id AND f.id = s.flow_id AND f.deleted_at IS NULL AND f.status <> 'obsolete'
       WHERE s.company_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL`, [COMPANY, o.id]);
    if (Number(n)) { notes.push(`operation ${code}: kept active because a current flow still uses it.`); continue; }
    await opsSvc.updateOperation(conn, c, o.id, { status: 'inactive' });
    retiredOps++;
  }
  say(`   retired ${retiredOps} old operation(s), ${retiredFlows} old flow(s) (${stillUsed} left active — still in use)`);

  detachNodeCache(conn);
  if (COMMIT) { await conn.commit(); say('\ncommitted.'); }
  else { await conn.rollback(); say('\ndry run — rolled back. Nothing was written.'); }

  say(`\n  created: ${JSON.stringify(tally.created)}`);
  say(`  reused : ${JSON.stringify(tally.reused)}`);
  say(`  skipped: ${JSON.stringify(tally.skipped)}`);
  if (notes.length) { say(`\n  ${notes.length} note(s):`); for (const n of notes) say(`   - ${n}`); }
  if (questions.length) { say(`\n  ${questions.length} question(s) for the user:`); for (const q of questions) say(`   ? ${q}`); }
} catch (e) {
  if (conn) await conn.rollback();
  console.error('\nFAILED:', e.code ?? '', e.message, e.problems ?? '');
  process.exitCode = 1;
} finally {
  if (conn) { detachNodeCache(conn); conn.release(); }
  await pool.end();
}
