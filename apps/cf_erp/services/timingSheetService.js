/**
 * timingSheetService.js — TIMINGS as spreadsheets, out and back in (user, 2026-10-31: "excel for … timings for the
 * entire flow"). Three sheets, each a download (.xlsx) and an upload ({ fileBase64, dryRun } → a preview; only a run
 * that is not a dry run writes), in the house pattern of orderSheetService / routes/bomSheet.js:
 *
 *   1. STANDARD TIMES   every operation's timing rules (cf_operation_machine_rules)
 *        GET  /operation-times/sheet                 POST /operation-times/sheet
 *   2. ORDER TIMES      one order's time per OPERATION (operation code -> setup and time per quantity, this order only)
 *        GET  /orders/:id/operation-times/sheet      POST /orders/:id/operation-times/sheet
 *   3. FLOOR PROGRESS   an order's (or one production order's) steps, and what was made at each
 *        GET  /orders/:id/floor-sheet?productionOrderId=     POST /orders/:id/floor-sheet
 *
 * PREPARED FILES. A sheet is matched by BUSINESS KEYS, never by hidden ids — the user demos with files typed by hand:
 * operation code, machine type / machine code, piece code. Columns are found by their HEADER text (row 2), so a
 * prepared file may leave grey columns out or put them in another order; grey columns are for reading and are not
 * read back. "Unchanged" means unchanged: a cell is compared with exactly what a download would write in it now.
 *
 * THE SAME SERVICES AS THE SCREENS
 *   1  operationService.createTimingRule / updateTimingRule (the Operations list's TimeBuilder and
 *      PUT /operation-rules/:id) — so an expression is validated exactly as the screen validates it. Every write runs
 *      inside a SAVEPOINT: a dry run (or a file with any problem) is rolled back to it, so the preview's problems are
 *      the services' own, for every row at once.
 *   2  cf_time_overrides, the Times tab's own cells: a line not released yet goes through
 *      timeEstimateService.setLineTimes (the Times grid's save); a released line's cells are written the same way and
 *      its steps not done yet are re-timed by productionOrderService.retimeOrderSteps — what clearing "Override all
 *      times to N seconds" runs. NO SCHEMA CHANGE: an operation's order time is that operation's typed time on every
 *      row of the order that has it. The one-number override, when on, still wins over everything (as before) — the
 *      sheet says so.
 *   3  releaseService.startStep / recordProgress, the per-step functions of "Finish selected"
 *      (stepBatchService), one transaction per row, in waves: a row whose step is not ready waits for earlier rows of
 *      the same file, exactly as the batch does. At most MAX_BATCH_STEPS rows that record something.
 */
import ExcelJS from 'exceljs';
import { CfError, invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { pool, withTransaction, insertRows } from '../lib/db.js';
import { LOCKED_ORDER_STATUSES } from './records.js';
import { listAllTimingRules, mainTimesOf, createTimingRule, updateTimingRule } from './operationService.js';
import { getLineTimes, setLineTimes } from './timeEstimateService.js';
import { retimeOrderSteps } from './productionOrderService.js';
import { evaluatedTracker, startStep, recordProgress } from './releaseService.js';
import { unplannedOf } from './planCheckService.js';
import { MAX_BATCH_STEPS } from './stepBatchService.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 50000;
const EPS = 1e-9;
const MAX_WAVES = 200;

const GREY_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const WHITE_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
const EDGE = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };

const blank = (v) => v == null || String(v).trim() === '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const round3 = (n) => Number(Number(n).toFixed(3));
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const isNumberText = (s) => !blank(s) && Number.isFinite(Number(String(s).trim()));
const up = (s) => String(s ?? '').trim().toUpperCase();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const reasonOf = (e) => [e?.message ?? String(e), ...(Array.isArray(e?.problems) ? e.problems : [])].filter(Boolean).join(' ');
const isDry = (input) => input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
const numText = (n) => (n == null ? '' : String(round3(n)));

/** One cell of an ExcelJS sheet as plain text (formulas, rich text flattened; a date as YYYY-MM-DD [HH:MM]). */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    // ExcelJS gives a date cell as that wall-clock time in UTC.
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return v.getUTCHours() || v.getUTCMinutes() ? `${d} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : d;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cellText(v.hyperlink);
    return '';
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(round6(v));
  return String(v).trim();
}

/** Two cell texts that say the same thing: the same text (case aside), or the same number written two ways. */
const sameText = (a, b) => {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (x.toLowerCase() === y.toLowerCase()) return true;
  return isNumberText(x) && isNumberText(y) && Math.abs(Number(x) - Number(y)) < 1e-6;
};

/** Yes / No / blank (null) — or undefined when it is neither. */
function yesNo(t) {
  const s = String(t ?? '').trim().toLowerCase();
  if (s === '') return null;
  if (['yes', 'y', 'true', '1', 'done'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
}

/* ===========================================================================
 * The workbook, both ways
 * ======================================================================== */

/**
 * A workbook of one sheet: row 1 a banner sentence, row 2 the headers, data from row 3. `columns` =
 * [{ key, header, width, edit, hidden }]: white (blue header) columns are read back, grey ones are not.
 */
async function buildWorkbook({ sheetName, banner, columns, rows, lists = {} }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = columns.map((col) => ({ key: col.key, width: col.width ?? 16, hidden: !!col.hidden }));
  ws.getCell(1, 1).value = banner;
  ws.getCell(1, 1).font = { italic: true, color: { argb: 'FF595959' } };
  ws.mergeCells(1, 1, 1, Math.max(1, columns.length));
  ws.getRow(1).height = 30;
  ws.getCell(1, 1).alignment = { wrapText: true, vertical: 'top' };
  const head = ws.getRow(2);
  columns.forEach((col, i) => {
    const cell = head.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true };
    cell.fill = col.edit ? WHITE_HEAD : GREY_HEAD;
    cell.border = BOX;
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  head.height = 32;
  rows.forEach((r, ri) => {
    const row = ws.getRow(ri + 3);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const v = r[col.key];
      cell.value = v === undefined || v === null ? null : v;
      cell.border = BOX;
      if (!col.edit) cell.fill = GREY;
      if (lists[col.key] && col.edit) {
        cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${lists[col.key].join(',')}"`] };
      }
    });
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Reads an uploaded workbook: the first sheet (or the one named `sheetName`), the header row (the first of rows 1–3
 * that names a `required` column), and every row below it as { sheetRow, get(key) }. Header text is matched loosely
 * (case, spaces, punctuation and a "(min)"-style unit aside), so a hand-made file reads too.
 */
async function readWorkbook(input, { sheetName, columns, required }) {
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to read — send the file as `fileBase64`.');
  let buffer;
  try { buffer = Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64'); } catch { buffer = null; }
  if (!buffer || !buffer.length) throw invalid('BAD_FILE', 'That file is empty.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file could not be opened as an Excel workbook (.xlsx).'); }
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  if (!ws) throw invalid('BAD_FILE', 'That workbook has no sheet.');
  const key = (h) => norm(String(h).replace(/\([^)]*\)/g, ''));
  const byHeader = new Map();
  for (const col of columns) for (const h of [col.header, ...(col.aliases ?? [])]) byHeader.set(key(h), col.key);
  let headRow = null;
  let at = {};
  for (let r = 1; r <= Math.min(3, ws.rowCount); r += 1) {
    const found = {};
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const k = byHeader.get(key(cellText(cell.value)));
      if (k && found[k] == null) found[k] = c;
    });
    if (required.every((k) => found[k] != null)) { headRow = r; at = found; break; }
  }
  if (!headRow) {
    const names = required.map((k) => columns.find((c) => c.key === k)?.header ?? k);
    throw invalid('BAD_FILE', `This is not that sheet — its header row needs the columns ${names.map((n) => `"${n}"`).join(', ')}. Download the sheet to see its layout.`);
  }
  const rows = [];
  for (let r = headRow + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const vals = {};
    let any = false;
    for (const [k, c] of Object.entries(at)) { vals[k] = cellText(row.getCell(c).value); if (vals[k] !== '') any = true; }
    if (!any) continue;
    rows.push({ sheetRow: r, get: (k) => vals[k] ?? '', has: (k) => at[k] != null });
    if (rows.length > MAX_ROWS) throw invalid('TOO_MANY', `A sheet holds at most ${MAX_ROWS} rows.`);
  }
  return { rows, has: (k) => at[k] != null };
}

const fileOut = (buffer, filename, rows) => ({ buffer, filename, rows, contentType: XLSX_TYPE });
const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet';

/** The house answer: { dryRun, ok, problems, changes, summary: { sentence, … } }. */
const answer = ({ dryRun, problems, changes, summary, ...rest }) => ({ dryRun, ok: problems.length === 0, problems, changes, summary, ...rest });

/** A minutes cell: '' = clear, a number of minutes zero or more, else a problem. */
function minutesOf(text, label, problems, where) {
  if (blank(text)) return null;
  const n = Number(String(text).trim());
  if (!Number.isFinite(n) || n < 0) { problems.push(`${where}: ${label} "${text}" is not a number of minutes, zero or more.`); return undefined; }
  if (n > 1e8) { problems.push(`${where}: ${label} is too large.`); return undefined; }
  return round3(n);
}

/* ===========================================================================
 * 1. STANDARD TIMES — every operation's timing rules
 * ======================================================================== */

const RULE_SHEET = 'Standard times';
const KIND_TYPE = 'Machine type';
const KIND_MACHINE = 'Machine';
const RULE_COLUMNS = [
  { key: 'op', header: 'Operation code', width: 16, edit: true },
  { key: 'opName', header: 'Operation name', width: 26 },
  { key: 'kind', header: 'Subject', width: 14, edit: true, aliases: ['Subject type', 'Machine type or machine'] },
  { key: 'subject', header: 'Machine type or machine code', width: 22, edit: true, aliases: ['Subject code', 'Machine type code', 'Machine code'] },
  { key: 'subjectName', header: 'Machine type or machine name', width: 26 },
  { key: 'setup', header: 'Setup time (min)', width: 22, edit: true, aliases: ['Setup time', 'Setup'] },
  { key: 'work', header: 'Time per quantity (min)', width: 30, edit: true, aliases: ['Work time', 'Work time per quantity', 'Time per piece'] },
  { key: 'from', header: 'Valid from', width: 13, edit: true },
  { key: 'to', header: 'Valid to', width: 13, edit: true },
  { key: 'eligible', header: 'Can do (Yes/No)', width: 14, edit: true, aliases: ['Can do', 'Eligible'] },
];
const RULE_BANNER = 'One row per timing rule. Times are minutes per piece: a number, or a formula as the Operations screen writes it '
  + '(item.X, machine.X, a chart by its name). Rows are matched by operation code + machine type or machine code; a new pair adds a rule. '
  + 'Grey columns are for reading only. Valid from / to as YYYY-MM-DD.';

/** What a download writes for a time: the minutes as a number, else the formula as the screen shows it. */
const timeCell = (t) => (t == null ? null : t.minutes != null ? Number(t.minutes) : (t.display ?? t.expression ?? null));
const timeText = (t) => { const v = timeCell(t); return v == null ? '' : String(v); };

export async function exportOperationTimesSheet(db, companyId) {
  const [ops] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL ORDER BY code', [companyId]);
  const rules = await listAllTimingRules(db, companyId);
  const byOp = new Map();
  for (const r of rules) { if (!byOp.has(r.operationId)) byOp.set(r.operationId, []); byOp.get(r.operationId).push(r); }
  const rows = [];
  for (const o of ops) {
    const list = byOp.get(o.id) ?? [];
    if (!list.length) rows.push({ op: o.code, opName: o.name });
    for (const r of list) {
      rows.push({
        op: o.code, opName: o.name,
        kind: r.subject.type === 'machine' ? KIND_MACHINE : KIND_TYPE,
        subject: r.subject.code ?? r.subject.name, subjectName: r.subject.name,
        setup: timeCell(r.setup), work: timeCell(r.work),
        from: r.effectiveFrom ?? null, to: r.effectiveTo ?? null,
        eligible: r.eligible ? 'Yes' : 'No',
      });
    }
  }
  const buffer = await buildWorkbook({ sheetName: RULE_SHEET, banner: RULE_BANNER, columns: RULE_COLUMNS, rows, lists: { kind: [KIND_TYPE, KIND_MACHINE], eligible: ['Yes', 'No'] } });
  return fileOut(buffer, `Standard_times_${new Date().toISOString().slice(0, 10)}.xlsx`, rows.length);
}

/** A date cell: '' = none, YYYY-MM-DD, else undefined (a problem). */
function dateOf(text, label, problems, where) {
  if (blank(text)) return null;
  const s = String(text).trim().slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    problems.push(`${where}: ${label} "${text}" is not a date — write it as YYYY-MM-DD.`);
    return undefined;
  }
  return s;
}

/** The input a time cell gives the rule services: unchanged -> {}; '' -> clear; a number -> minutes; else a formula. */
function timeInput(which, text, current) {
  if (sameText(text, timeText(current))) return null;
  const m = `${which}Minutes`;
  const f = `${which}FormulaId`;
  const x = `${which}Expression`;
  if (blank(text)) return { [x]: '' };
  if (isNumberText(text)) return { [m]: Number(String(text).trim()), [f]: null };
  return { [x]: String(text).trim() };
}

/**
 * POST /operation-times/sheet { fileBase64, dryRun? } — needs a transaction. Updates the rule matched by operation code
 * + subject (and Valid from, when the operation has several rules for that subject), adds a rule for a new pair.
 */
export async function importOperationTimesSheet(db, c, input = {}) {
  const dryRun = isDry(input);
  const { rows } = await readWorkbook(input, { sheetName: RULE_SHEET, columns: RULE_COLUMNS, required: ['op', 'setup', 'work'] });
  const problems = [];
  const changes = [];
  const [ops] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const opByCode = new Map(ops.map((o) => [up(o.code), o]));
  const [nodes] = await db.query("SELECT id, code, name, depth FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL", [c.companyId]);
  const [machines] = await db.query('SELECT id, code, name FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const rules = await listAllTimingRules(db, c.companyId);
  const rulesOf = new Map();
  for (const r of rules) {
    const k = `${r.operationId}|${r.subject.type}|${r.subject.id}`;
    if (!rulesOf.has(k)) rulesOf.set(k, []);
    rulesOf.get(k).push(r);
  }
  const findType = (t) => {
    const byCode = nodes.filter((n) => !blank(n.code) && up(n.code) === up(t));
    return byCode.length ? byCode : nodes.filter((n) => up(n.name) === up(t));
  };
  const findMachine = (t) => {
    const byCode = machines.filter((m) => !blank(m.code) && up(m.code) === up(t));
    return byCode.length ? byCode : machines.filter((m) => up(m.name) === up(t));
  };

  const plan = [];
  const seen = new Map();
  let unchanged = 0;
  for (const row of rows) {
    const where = `Sheet row ${row.sheetRow}`;
    const opCode = row.get('op');
    const kindText = row.get('kind');
    const subjText = row.get('subject');
    const filled = ['setup', 'work', 'from', 'to'].some((k) => !blank(row.get(k)));
    if (blank(opCode)) { problems.push(`${where}: the operation code is empty.`); continue; }
    const op = opByCode.get(up(opCode));
    if (!op) { problems.push(`${where}: there is no operation "${opCode}". Operations are added on the Operations screen.`); continue; }
    if (blank(subjText)) {
      if (filled) problems.push(`${where} (${op.code}): say which machine type or machine the times are for.`);
      continue; // an operation with no rule yet, left as it is
    }
    const kindNorm = norm(kindText);
    let kind = null;
    if (kindNorm === '' ) kind = null;
    else if (['machine type', 'type', 'classification', 'machine family', 'family'].includes(kindNorm)) kind = 'classification';
    else if (kindNorm === 'machine') kind = 'machine';
    else { problems.push(`${where} (${op.code}): Subject is "${KIND_TYPE}" or "${KIND_MACHINE}" — "${kindText}" is neither.`); continue; }
    const types = kind !== 'machine' ? findType(subjText) : [];
    const mcs = kind !== 'classification' ? findMachine(subjText) : [];
    let subject = null;
    if (kind == null && types.length && mcs.length) { problems.push(`${where} (${op.code}): "${subjText}" is both a machine type and a machine — say which under Subject.`); continue; }
    if (types.length > 1) { problems.push(`${where} (${op.code}): ${types.length} machine types are called "${subjText}" — use the type's own code.`); continue; }
    if (mcs.length > 1) { problems.push(`${where} (${op.code}): ${mcs.length} machines are called "${subjText}" — use the machine's own code.`); continue; }
    if (types.length) subject = { type: 'classification', id: types[0].id, label: types[0].code ?? types[0].name };
    else if (mcs.length) subject = { type: 'machine', id: mcs[0].id, label: mcs[0].code ?? mcs[0].name };
    else {
      problems.push(`${where} (${op.code}): there is no ${kind === 'machine' ? 'machine' : kind === 'classification' ? 'machine type' : 'machine type or machine'} "${subjText}".`);
      continue;
    }
    const label = `${op.code} · ${subject.label}`;
    const from = dateOf(row.get('from'), 'Valid from', problems, `${where} (${label})`);
    const to = dateOf(row.get('to'), 'Valid to', problems, `${where} (${label})`);
    const eligible = row.has('eligible') ? yesNo(row.get('eligible')) : null;
    if (eligible === undefined) { problems.push(`${where} (${label}): Can do is Yes or No — "${row.get('eligible')}" is neither.`); continue; }
    if (from === undefined || to === undefined) continue;
    const existing = rulesOf.get(`${op.id}|${subject.type}|${subject.id}`) ?? [];
    let rule = null;
    if (existing.length === 1) rule = existing[0];
    else if (existing.length > 1) rule = existing.find((r) => (r.effectiveFrom ?? null) === from) ?? null;
    const key = rule ? `rule:${rule.id}` : `new:${op.id}|${subject.type}|${subject.id}|${from ?? ''}`;
    if (seen.has(key)) { problems.push(`${label} is in the sheet twice (sheet rows ${seen.get(key)} and ${row.sheetRow}). Keep one row for it.`); continue; }
    seen.set(key, row.sheetRow);
    if (rule) {
      const body = {};
      const said = [];
      const st = timeInput('setup', row.get('setup'), rule.setup);
      if (st) { Object.assign(body, st); said.push({ field: 'Setup time', from: timeText(rule.setup) || 'none', to: row.get('setup') || 'none' }); }
      const wt = timeInput('work', row.get('work'), rule.work);
      if (wt) { Object.assign(body, wt); said.push({ field: 'Time per quantity', from: timeText(rule.work) || 'none', to: row.get('work') || 'none' }); }
      if (row.has('from') && (rule.effectiveFrom ?? null) !== from) { body.effectiveFrom = from; said.push({ field: 'Valid from', from: rule.effectiveFrom ?? 'none', to: from ?? 'none' }); }
      if (row.has('to') && (rule.effectiveTo ?? null) !== to) { body.effectiveTo = to; said.push({ field: 'Valid to', from: rule.effectiveTo ?? 'none', to: to ?? 'none' }); }
      if (eligible != null && eligible !== rule.eligible) { body.eligible = eligible; said.push({ field: 'Can do', from: rule.eligible ? 'Yes' : 'No', to: eligible ? 'Yes' : 'No' }); }
      if (!said.length) { unchanged += 1; continue; }
      plan.push({ where: `${where} (${label})`, action: 'update', ruleId: rule.id, body, said, label });
    } else {
      const body = { subjectType: subject.type, subjectId: subject.id, eligible: eligible ?? true, effectiveFrom: from, effectiveTo: to };
      const s = row.get('setup');
      const w = row.get('work');
      if (!blank(s)) Object.assign(body, isNumberText(s) ? { setupMinutes: Number(s) } : { setupExpression: s });
      if (!blank(w)) Object.assign(body, isNumberText(w) ? { workMinutes: Number(w) } : { workExpression: w });
      plan.push({ where: `${where} (${label})`, action: 'add', opId: op.id, body, label, said: [{ field: 'New rule', to: [`setup ${s || 'none'}`, `per quantity ${w || 'none'}`].join(', ') }] });
    }
  }

  // Every write through the screens' own services, inside a savepoint: their refusals are this file's problems.
  let added = 0;
  let updated = 0;
  if (plan.length) {
    await db.query('SAVEPOINT timing_sheet');
    for (const p of plan) {
      try {
        if (p.action === 'update') await updateTimingRule(db, c, p.ruleId, p.body);
        else await createTimingRule(db, c, p.opId, p.body);
        if (p.action === 'update') updated += 1; else added += 1;
        for (const s of p.said) changes.push({ action: p.action, path: p.label, field: s.field, from: s.from, to: s.to });
      } catch (e) {
        if (!(e instanceof CfError) && !e?.sqlMessage) throw e;
        problems.push(`${p.where}: ${reasonOf(e)}`);
      }
    }
    if (dryRun || problems.length) await db.query('ROLLBACK TO SAVEPOINT timing_sheet');
    else await db.query('RELEASE SAVEPOINT timing_sheet');
  }
  const summary = { rowsInSheet: rows.length, rulesUpdated: updated, rulesAdded: added, unchanged };
  if (problems.length) {
    if (!dryRun) assertNoProblems(problems, `That sheet was not applied — ${plural(problems.length, 'problem', 'problems')} to fix first.`);
    return answer({ dryRun, problems, changes: [], summary: { ...summary, rulesUpdated: 0, rulesAdded: 0, sentence: 'nothing — fix the sheet first' } });
  }
  const parts = [updated && `${plural(updated, 'rule', 'rules')} changed`, added && `${plural(added, 'rule', 'rules')} added`].filter(Boolean);
  summary.sentence = parts.length ? `${parts.join(', ')}${unchanged ? `, ${unchanged} unchanged` : ''}` : 'nothing to change — every row is as the system has it';
  return answer({ dryRun, problems, changes, summary, ...(dryRun ? {} : { applied: plan.length > 0 }) });
}

/* ===========================================================================
 * 2. ORDER TIMES — one order's time per operation
 * ======================================================================== */

const ORDER_SHEET = 'Order times';
const ORDER_COLUMNS = [
  { key: 'op', header: 'Operation code', width: 16, edit: true },
  { key: 'opName', header: 'Operation name', width: 26 },
  { key: 'rows', header: 'Rows of the order', width: 12 },
  { key: 'steps', header: 'Steps released', width: 12 },
  { key: 'stdSetup', header: 'Standard setup (min)', width: 22 },
  { key: 'stdWork', header: 'Standard time per quantity (min)', width: 28 },
  { key: 'setup', header: 'Order setup (min)', width: 16, edit: true, aliases: ['Setup time', 'Setup'] },
  { key: 'work', header: 'Order time per quantity (min)', width: 20, edit: true, aliases: ['Time per quantity', 'Work time', 'Work time per quantity'] },
  { key: 'note', header: 'Note', width: 40 },
];

async function orderRow(db, companyId, orderId, { lock = false } = {}) {
  const [[order]] = await db.query(
    `SELECT id, code, status, time_override_seconds FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [companyId, orderId],
  );
  if (!order) throw notFound('Sales order');
  return order;
}

/**
 * Every (line, row, operation) cell of the order: a released line's from its steps, a line not released yet from its
 * Times grid (getLineTimes — the rows' flows). With the typed times on them and each operation's standard (main rule).
 */
async function orderCells(db, companyId, order) {
  const [lines] = await db.query(
    `SELECT ol.id, ol.line_no, ol.item_id,
            (SELECT r.id FROM cf_production_releases r WHERE r.company_id = ol.company_id AND r.order_line_id = ol.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
       FROM cf_sales_order_lines ol WHERE ol.company_id = ? AND ol.order_id = ? AND ol.deleted_at IS NULL ORDER BY ol.line_no, ol.id`,
    [companyId, order.id],
  );
  const cells = new Map(); // `${line}:${bomKey}:${op}` -> { lineId, bomLineId, operationId, released, steps, open }
  const add = (lineId, bomLineId, operationId, released, steps = 0, open = 0) => {
    const k = `${lineId}:${bomLineId ?? 0}:${operationId}`;
    const cur = cells.get(k) ?? { lineId: Number(lineId), bomLineId: bomLineId == null ? null : Number(bomLineId), operationId: Number(operationId), released, steps: 0, open: 0 };
    cur.steps += Number(steps); cur.open += Number(open);
    cells.set(k, cur);
  };
  const released = lines.filter((l) => l.release_id != null);
  if (released.length) {
    const [rows] = await db.query(
      `SELECT r.order_line_id, pi.bom_line_id, s.operation_id, COUNT(*) AS steps, SUM(s.state <> 'done') AS open_steps
         FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND r.order_id = ? AND s.deleted_at IS NULL
        GROUP BY r.order_line_id, pi.bom_line_id, s.operation_id`,
      [companyId, order.id],
    );
    for (const r of rows) add(r.order_line_id, r.bom_line_id, r.operation_id, true, r.steps, r.open_steps);
  }
  for (const l of lines.filter((x) => x.release_id == null && x.item_id != null)) {
    const view = await getLineTimes(db, companyId, order.id, l.id);
    for (const row of view.rows) for (const opId of Object.keys(row.cells ?? {})) add(l.id, row.bomLineId, opId, false);
  }
  const lineIds = lines.map((l) => l.id);
  const overrides = new Map();
  if (lineIds.length) {
    const [ov] = await db.query(
      'SELECT id, order_line_id, bom_line_id, operation_id, work_minutes, setup_minutes, note FROM cf_time_overrides WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL',
      [companyId, lineIds],
    );
    for (const o of ov) {
      overrides.set(`${o.order_line_id}:${o.bom_line_id ?? 0}:${o.operation_id}`, {
        id: o.id, work: o.work_minutes == null ? null : Number(o.work_minutes), setup: o.setup_minutes == null ? null : Number(o.setup_minutes), note: o.note ?? null,
      });
    }
  }
  const opIds = [...new Set([...cells.values()].map((x) => x.operationId))];
  const ops = new Map();
  if (opIds.length) {
    const [rows] = await db.query('SELECT id, code, name FROM cf_operations WHERE company_id = ? AND id IN (?) ORDER BY code', [companyId, opIds]);
    for (const r of rows) ops.set(Number(r.id), r);
  }
  const standard = await mainTimesOf(db, companyId, opIds);
  // Per operation: its cells and the time common to all of them (null when not every cell has the same typed value).
  const byOp = new Map();
  for (const [k, cell] of cells) {
    if (!byOp.has(cell.operationId)) byOp.set(cell.operationId, []);
    byOp.get(cell.operationId).push({ key: k, ...cell, override: overrides.get(k) ?? null });
  }
  const common = (list, f) => {
    const vals = list.map((x) => x.override?.[f] ?? null);
    if (vals.some((v) => v == null)) return { value: null, mixed: vals.some((v) => v != null) };
    return vals.every((v) => Math.abs(v - vals[0]) < 1e-9) ? { value: vals[0], mixed: false } : { value: null, mixed: true };
  };
  const perOp = [...byOp.entries()].map(([opId, list]) => ({
    op: ops.get(opId) ?? { id: opId, code: `#${opId}`, name: '' },
    cells: list,
    setup: common(list, 'setup'),
    work: common(list, 'work'),
    steps: list.reduce((a, x) => a + x.steps, 0),
    open: list.reduce((a, x) => a + x.open, 0),
    standard: standard.get(opId) ?? null,
  })).sort((a, b) => String(a.op.code).localeCompare(String(b.op.code)));
  return { lines, perOp };
}

const overrideSecondsOf = (order) => (order.time_override_seconds == null ? null : Number(order.time_override_seconds));

export async function exportOrderOperationTimesSheet(db, companyId, orderId) {
  const order = await orderRow(db, companyId, orderId);
  const { perOp } = await orderCells(db, companyId, order);
  const ovr = overrideSecondsOf(order);
  const rows = perOp.map((p) => ({
    op: p.op.code, opName: p.op.name,
    rows: p.cells.length, steps: p.steps,
    stdSetup: timeCell(p.standard?.setup), stdWork: timeCell(p.standard?.work),
    setup: p.setup.value, work: p.work.value,
    note: [
      ovr != null ? `"Override all times" is on (${ovr} s) and wins until it is cleared.` : null,
      p.setup.mixed || p.work.mixed ? 'Typed times differ from row to row on the Times tab — a number here sets every row.' : null,
    ].filter(Boolean).join(' ') || null,
  }));
  const banner = `${order.code}: one row per operation its steps use. Type this order's setup and time per quantity in minutes; `
    + 'blank = the standard (the formula). Every row of the order with that operation gets the time; steps not done yet are re-timed.';
  const buffer = await buildWorkbook({ sheetName: ORDER_SHEET, banner, columns: ORDER_COLUMNS, rows });
  return fileOut(buffer, `Order_times_${safeName(order.code)}.xlsx`, rows.length);
}

/**
 * POST /orders/:id/operation-times/sheet { fileBase64, dryRun? } — needs a transaction. A changed cell sets (or, emptied,
 * clears) that operation's typed time on every row of the order that has it.
 */
export async function importOrderOperationTimesSheet(db, c, orderId, input = {}) {
  const dryRun = isDry(input);
  const { rows, has } = await readWorkbook(input, { sheetName: ORDER_SHEET, columns: ORDER_COLUMNS, required: ['op'] });
  if (!has('setup') && !has('work')) throw invalid('BAD_FILE', 'This sheet has neither an "Order setup (min)" nor an "Order time per quantity (min)" column.');
  const order = await orderRow(db, c.companyId, orderId, { lock: !dryRun });
  if (order.status === 'revised' || LOCKED_ORDER_STATUSES.has(order.status)) throw invalid('ORDER_LOCKED', `${order.code} is ${order.status} — its times do not change.`);
  const { perOp } = await orderCells(db, c.companyId, order);
  const byCode = new Map(perOp.map((p) => [up(p.op.code), p]));
  const problems = [];
  const changes = [];
  const seen = new Map();
  const want = []; // { p, setup?: number|null, work?: number|null }
  let unchanged = 0;
  for (const row of rows) {
    const where = `Sheet row ${row.sheetRow}`;
    const code = row.get('op');
    if (blank(code)) { problems.push(`${where}: the operation code is empty.`); continue; }
    const p = byCode.get(up(code));
    if (!p) { problems.push(`${where}: no step of ${order.code} uses operation "${code}" — download the sheet to see the operations it uses.`); continue; }
    if (seen.has(p.op.id)) { problems.push(`${p.op.code} is in the sheet twice (sheet rows ${seen.get(p.op.id)} and ${row.sheetRow}). Keep one row for it.`); continue; }
    seen.set(p.op.id, row.sheetRow);
    const w = { p };
    for (const [f, label] of [['setup', 'Order setup'], ['work', 'Order time per quantity']]) {
      if (!has(f)) continue;
      const text = row.get(f);
      if (sameText(text, numText(p[f].value))) continue;
      const v = minutesOf(text, label, problems, `${where} (${p.op.code})`);
      if (v === undefined) continue;
      if (v == null && !p[f].mixed && p[f].value == null) continue; // already the standard everywhere
      w[f] = v;
      changes.push({ action: 'update', path: `${p.op.code} · ${p.op.name}`, field: label, from: p[f].value == null ? (p[f].mixed ? 'differs by row' : 'standard') : p[f].value, to: v == null ? 'standard' : v, detail: `${plural(p.cells.length, 'row', 'rows')}` });
    }
    if (w.setup === undefined && w.work === undefined) { unchanged += 1; continue; }
    want.push(w);
  }
  const cellsTouched = want.reduce((a, w) => a + w.p.cells.length, 0);
  const stepsToRetime = want.reduce((a, w) => a + w.p.open, 0);
  const ovr = overrideSecondsOf(order);
  const warning = ovr != null ? `"Override all times to ${ovr} s" is on for ${order.code}: it wins over these times until it is cleared.` : null;
  const summary = { rowsInSheet: rows.length, operationsChanged: want.length, cellsChanged: cellsTouched, stepsToRetime, unchanged, ...(warning ? { warning } : {}) };
  if (problems.length) {
    if (!dryRun) assertNoProblems(problems, `That sheet was not applied — ${plural(problems.length, 'problem', 'problems')} to fix first.`);
    return answer({ dryRun, problems, changes: [], summary: { ...summary, operationsChanged: 0, sentence: 'nothing — fix the sheet first' } });
  }
  const sentence = want.length
    ? `${plural(want.length, 'operation', 'operations')} of ${order.code} get new times (${plural(cellsTouched, 'row', 'rows')}${stepsToRetime ? `, ${plural(stepsToRetime, 'step', 'steps')} not done re-timed` : ''})${unchanged ? `, ${unchanged} unchanged` : ''}${warning ? ` — ${warning}` : ''}`
    : 'nothing to change — every operation is as the order has it';
  if (dryRun || !want.length) return answer({ dryRun, problems, changes, summary: { ...summary, sentence } });

  // Lines not released yet: the Times grid's own save, one call a line. Released lines: the same cells written here.
  const unreleasedByLine = new Map();
  const releasedCells = [];
  for (const w of want) {
    for (const cell of w.p.cells) {
      const one = { bomLineId: cell.bomLineId, operationId: cell.operationId };
      if (w.setup !== undefined) one.setup = w.setup;
      if (w.work !== undefined) one.work = w.work;
      if (cell.released) releasedCells.push({ ...one, lineId: cell.lineId, key: cell.key, cur: cell.override });
      else { if (!unreleasedByLine.has(cell.lineId)) unreleasedByLine.set(cell.lineId, []); unreleasedByLine.get(cell.lineId).push(one); }
    }
  }
  for (const [lineId, cells] of unreleasedByLine) await setLineTimes(db, c, order.id, lineId, { cells });
  let retimed = 0;
  if (releasedCells.length) {
    await writeReleasedOverrides(db, c, releasedCells);
    retimed = await retimeOrderSteps(db, c, order.id);
  }
  return answer({ dryRun, problems, changes, summary: { ...summary, stepsRetimed: retimed, sentence }, applied: true });
}

/** cf_time_overrides for released lines, as setLineTimes writes them (both null = the row is retired). */
async function writeReleasedOverrides(db, c, cells) {
  const inserts = [];
  const updates = [];
  const retire = [];
  for (const w of cells) {
    const cur = w.cur;
    const work = w.work !== undefined ? w.work : cur?.work ?? null;
    const setup = w.setup !== undefined ? w.setup : cur?.setup ?? null;
    const note = cur?.note ?? null;
    if (work == null && setup == null) { if (cur) retire.push(cur.id); continue; }
    if (cur) { if (cur.work !== work || cur.setup !== setup) updates.push({ id: cur.id, work, setup }); continue; }
    inserts.push([c.companyId, w.lineId, w.bomLineId, w.operationId, work, setup, note, c.userId ?? null]);
  }
  if (retire.length) await db.query('UPDATE cf_time_overrides SET deleted_at = NOW(), updated_by = ? WHERE company_id = ? AND id IN (?)', [c.userId ?? null, c.companyId, retire]);
  for (let i = 0; i < updates.length; i += 200) {
    const part = updates.slice(i, i + 200);
    const cases = () => `CASE id ${part.map(() => 'WHEN ? THEN ?').join(' ')} END`;
    await db.query(
      `UPDATE cf_time_overrides SET work_minutes = ${cases()}, setup_minutes = ${cases()}, updated_by = ? WHERE company_id = ? AND id IN (?)`,
      [...part.flatMap((u) => [u.id, u.work]), ...part.flatMap((u) => [u.id, u.setup]), c.userId ?? null, c.companyId, part.map((u) => u.id)],
    );
  }
  for (let i = 0; i < inserts.length; i += 500) {
    await insertRows(db, 'cf_time_overrides',
      ['company_id', 'order_line_id', 'bom_line_id', 'operation_id', 'work_minutes', 'setup_minutes', 'note', 'updated_by'], inserts.slice(i, i + 500));
  }
}

/* ===========================================================================
 * 3. FLOOR PROGRESS — an order's steps, and what was made at each
 * ======================================================================== */

const FLOOR_SHEET = 'Floor progress';
const FLOOR_COLUMNS = [
  { key: 'po', header: 'Production order', width: 16 },
  { key: 'piece', header: 'Piece code', width: 28, edit: true },
  { key: 'op', header: 'Operation code', width: 14, edit: true },
  { key: 'step', header: 'Step', width: 24, edit: true, aliases: ['Step label'] },
  { key: 'opName', header: 'Operation', width: 20 },
  { key: 'qty', header: 'Quantity', width: 10 },
  { key: 'good', header: 'Good so far', width: 11 },
  { key: 'scrap', header: 'Scrap so far', width: 11 },
  { key: 'state', header: 'State', width: 12 },
  { key: 'ready', header: 'Ready?', width: 34 },
  { key: 'addGood', header: 'Good to add', width: 12, edit: true, aliases: ['Good qty', 'Good'] },
  { key: 'addScrap', header: 'Scrap to add', width: 12, edit: true, aliases: ['Scrap qty', 'Scrap'] },
  { key: 'done', header: 'Done (Yes/No)', width: 12, edit: true, aliases: ['Done'] },
  { key: 'at', header: 'Finished at', width: 18, edit: true, aliases: ['Finished at (YYYY-MM-DD HH:MM)', 'Done at'] },
];
const STATE_LABEL = { ready: 'Ready', in_progress: 'In progress', not_ready: 'Waiting', on_hold: 'On hold', done: 'Done' };

/** The order's releases evaluated (one tracker read), its steps in the tracker's order, scoped to a production order. */
async function floorSteps(db, companyId, orderId, productionOrderId) {
  const [[order]] = await db.query('SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, orderId]);
  if (!order) throw notFound('Sales order');
  const [pos] = await db.query('SELECT id, code FROM cf_production_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, order.id]);
  const poById = new Map(pos.map((p) => [Number(p.id), p]));
  let po = null;
  if (!blank(productionOrderId)) {
    po = poById.get(Number(productionOrderId)) ?? null;
    if (!po) throw invalid('WRONG_ORDER', `That production order is not one of ${order.code}'s.`);
  }
  const [rels] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, order.id]);
  const releaseIds = rels.map((r) => Number(r.id));
  const data = releaseIds.length ? await evaluatedTracker(db, companyId, releaseIds) : null;
  const steps = (data?.steps ?? []).filter((s) => !po || Number(s.production_order_id) === po.id);
  return { order, po, poById, releaseIds, data, steps };
}

const pieceCodeOf = (data, s) => { const it = data.itemById.get(s.production_item_id); return it?.code ?? it?._label ?? ''; };
const stepLabelOf = (s) => s._opLabel ?? s.step_name ?? s.op_name;
const readyText = (s) => (s._status === 'ready' || s._status === 'in_progress' ? 'Yes'
  : s._status === 'done' ? 'Done'
    : s._status === 'on_hold' ? 'No — on hold'
      : `No — ${(s._blockers ?? []).map((b) => b.text).join(' ') || 'waiting'}`);

export async function exportFloorSheet(db, companyId, orderId, { productionOrderId } = {}) {
  const { order, po, poById, data, steps } = await floorSteps(db, companyId, orderId, productionOrderId);
  const rows = steps.map((s) => ({
    po: poById.get(Number(s.production_order_id))?.code ?? null,
    piece: pieceCodeOf(data, s), op: s.op_code, step: stepLabelOf(s), opName: s.op_name,
    qty: Number(s.quantity), good: Number(s.qty_good), scrap: Number(s.qty_scrap),
    state: STATE_LABEL[s._status] ?? s._status, ready: readyText(s),
  }));
  const banner = `${po ? po.code : order.code}: one row per step. Fill Good to add / Scrap to add / Done (Yes = finish it; Good to add left empty = what is left) `
    + 'and Finished at (YYYY-MM-DD HH:MM, your time) for what was made. Rows are matched by piece code + operation code (+ Step for an operation done in several passes) '
    + 'and recorded in step order; a step that is not ready waits for earlier rows of the file.';
  const buffer = await buildWorkbook({ sheetName: FLOOR_SHEET, banner, columns: FLOOR_COLUMNS, rows, lists: { done: ['Yes', 'No'] } });
  return fileOut(buffer, `Floor_progress_${safeName(po ? po.code : order.code)}.xlsx`, rows.length);
}

/** A "Finished at" cell as an ISO time with its zone. Wall-clock text and Excel dates are read in the uploader's zone (`tz`, minutes east of UTC). */
function atOf(text, tzMinutes, problems, where) {
  if (blank(text)) return null;
  const s = String(text).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s))) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) { problems.push(`${where}: Finished at "${s}" is not a date and time — write it as YYYY-MM-DD HH:MM.`); return undefined; }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - tzMinutes * 60000;
  if (!Number.isFinite(ms)) { problems.push(`${where}: Finished at "${s}" is not a date and time.`); return undefined; }
  if (ms > Date.now() + 60000) { problems.push(`${where}: Finished at ${s} is in the future.`); return undefined; }
  return new Date(ms).toISOString();
}

/**
 * Reads and checks the file against the order's steps: every problem at once. Returns the rows that record something,
 * each with its step: { where, label, stepId, good|null (null = what is left), scrap, done, at }.
 */
async function planFloor(db, c, orderId, input) {
  const { rows } = await readWorkbook(input, { sheetName: FLOOR_SHEET, columns: FLOOR_COLUMNS, required: ['piece', 'op'] });
  const ctx = await floorSteps(db, c.companyId, orderId, input.productionOrderId);
  const tz = Number.isFinite(Number(input.tz)) ? Number(input.tz) : 330;
  const byKey = new Map();
  for (const s of ctx.steps) {
    const k = `${up(pieceCodeOf(ctx.data, s))}|${up(s.op_code)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const problems = [];
  const plan = [];
  const seen = new Map();
  let unchanged = 0;
  for (const row of rows) {
    const where = `Sheet row ${row.sheetRow}`;
    const piece = row.get('piece');
    const opCode = row.get('op');
    const gText = row.get('addGood');
    const sText = row.get('addScrap');
    const done = yesNo(row.get('done'));
    if (done === undefined) { problems.push(`${where}: Done is Yes or No — "${row.get('done')}" is neither.`); continue; }
    if (blank(gText) && blank(sText) && done !== true) { unchanged += 1; continue; }
    if (blank(piece) || blank(opCode)) { problems.push(`${where}: a row that records something needs its piece code and operation code.`); continue; }
    const label = `${piece} · ${opCode}`;
    let cands = byKey.get(`${up(piece)}|${up(opCode)}`) ?? [];
    if (!cands.length) { problems.push(`${where}: ${label} is not a step of ${ctx.po?.code ?? ctx.order.code}.`); continue; }
    if (cands.length > 1) {
      const st = row.get('step');
      const pick = cands.filter((s) => sameText(stepLabelOf(s), st));
      if (pick.length !== 1) { problems.push(`${where}: ${label} is ${cands.length} steps (${cands.map(stepLabelOf).join(', ')}) — say which under Step.`); continue; }
      cands = pick;
    }
    const s = cands[0];
    const lab = `${pieceCodeOf(ctx.data, s)} · ${stepLabelOf(s)}`;
    if (seen.has(s.id)) { problems.push(`${lab} is in the sheet twice (sheet rows ${seen.get(s.id)} and ${row.sheetRow}). Keep one row for it.`); continue; }
    seen.set(s.id, row.sheetRow);
    const num = (t, name) => {
      if (blank(t)) return null;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) { problems.push(`${where} (${lab}): ${name} "${t}" is not a number, zero or more.`); return undefined; }
      return round6(n);
    };
    const good = num(gText, 'Good to add');
    const scrap = num(sText, 'Scrap to add');
    const at = atOf(row.get('at'), tz, problems, `${where} (${lab})`);
    if (good === undefined || scrap === undefined || at === undefined) continue;
    const left = round6(Number(s.quantity) - Number(s.qty_good));
    if (s._status !== 'done') {
      if (good != null && good > left + EPS) { problems.push(`${where} (${lab}): Good to add is ${good}, but only ${left} more good ${left === 1 ? 'piece is' : 'pieces are'} needed at this step.`); continue; }
      if (done === true && good != null && good < left - EPS) { problems.push(`${where} (${lab}): Done is Yes, but ${good} good leaves ${round6(left - good)} still to make — put ${left} under Good to add, or leave it empty.`); continue; }
      if (done !== true && (good ?? 0) + (scrap ?? 0) <= EPS) { problems.push(`${where} (${lab}): nothing to record — put a quantity under Good to add or Scrap to add, or Done = Yes.`); continue; }
    }
    plan.push({ where, label: lab, stepId: s.id, good: done === true && good == null ? null : (good ?? 0), scrap: scrap ?? 0, done: done === true, at, sheetRow: row.sheetRow });
  }
  if (plan.length > MAX_BATCH_STEPS) problems.push(`One sheet records at most ${MAX_BATCH_STEPS} steps, and this one records ${plan.length}. Split it into parts.`);
  return { ctx, rows, plan, problems, unchanged };
}

/**
 * POST /orders/:id/floor-sheet { fileBase64, dryRun?, productionOrderId?, tz?, note? }.
 * A dry run checks the file and says what is ready now and what waits; a real run records each row through startStep +
 * recordProgress, ONE TRANSACTION PER ROW, in waves (as stepBatchService.finishSteps): one refusal does not undo the
 * rest. → { …, done: [{ stepId, label, good, scrap, wave }], refused: [{ stepId, label, reason }] }.
 * `opts.db` / `opts.tx` replace the pool and withTransaction (a test runs everything in its own transaction).
 */
export async function importFloorSheet(c, orderId, input = {}, opts = {}) {
  const readDb = opts.db ?? pool;
  const tx = opts.tx ?? withTransaction;
  const dryRun = isDry(input);
  const { ctx, rows, plan, problems, unchanged } = await planFloor(readDb, c, orderId, input);
  const byId = new Map(ctx.steps.map((s) => [s.id, s]));
  const summary = { rowsInSheet: rows.length, rowsToRecord: plan.length, unchanged };
  if (problems.length) {
    if (!dryRun) assertNoProblems(problems, `That sheet was not applied — ${plural(problems.length, 'problem', 'problems')} to fix first.`);
    return answer({ dryRun, problems, changes: [], summary: { ...summary, sentence: 'nothing — fix the sheet first' }, done: [], refused: [] });
  }
  const describe = (p) => [p.good == null ? 'finish with what is left good' : p.good ? `good +${p.good}` : null, p.scrap ? `scrap +${p.scrap}` : null, p.done && p.good != null ? 'done' : null, p.at ? `at ${p.at}` : null].filter(Boolean).join(', ');
  if (dryRun) {
    const changes = plan.map((p) => {
      const s = byId.get(p.stepId);
      const status = s._status === 'ready' || s._status === 'in_progress' ? 'ready now'
        : s._status === 'done' ? 'already done — will be refused'
          : s._status === 'on_hold' ? 'on hold — will be refused unless resumed'
            : plan.length > 1 ? 'waits — goes after earlier rows of this file, if they finish what it waits for' : 'waits — will be refused';
      return { action: 'record', path: p.label, detail: `${describe(p)} · ${status}`, stepId: p.stepId };
    });
    const ready = plan.filter((p) => ['ready', 'in_progress'].includes(byId.get(p.stepId)._status)).length;
    const sentence = plan.length
      ? `${plural(plan.length, 'step', 'steps')} to record — ${ready} ready now${plan.length - ready ? `, ${plan.length - ready} waiting or not open` : ''}${unchanged ? `; ${unchanged} rows unchanged` : ''}`
      : 'nothing to record — no row has a quantity or Done = Yes';
    return answer({ dryRun, problems, changes, summary: { ...summary, readyNow: ready, sentence }, done: [], refused: [] });
  }

  const note = blank(input.note) ? 'From the floor progress sheet' : String(input.note);
  const want = new Map(plan.map((p) => [p.stepId, p]));
  const open = new Set(want.keys());
  const unplanned = open.size ? new Set((await unplannedOf(readDb, c.companyId, [...open])).keys()) : new Set();
  const done = [];
  const refused = [];
  let waves = 0;
  while (open.size && waves < MAX_WAVES) {
    const data = await evaluatedTracker(readDb, c.companyId, ctx.releaseIds);
    if (!data) break;
    const mine = data.steps.filter((s) => open.has(s.id));
    for (const s of mine.filter((x) => x._status === 'done')) {
      open.delete(s.id);
      refused.push({ stepId: s.id, label: want.get(s.id).label, reason: 'It is already done.' });
    }
    const now = mine.filter((s) => s._status === 'ready' || s._status === 'in_progress');
    if (!now.length) break;
    waves += 1;
    for (const s of now) {
      open.delete(s.id);
      const p = want.get(s.id);
      const left = round6(Number(s.quantity) - Number(s.qty_good));
      const good = p.good == null ? left : p.good;
      const records = good + p.scrap > EPS;
      try {
        await tx(async (db) => {
          if (s.state === 'pending') await startStep(db, c, s.id, { view: 'none', note, at: p.at ?? undefined }, { evaluated: data, unplanned, ledger: !records });
          if (records) await recordProgress(db, c, s.id, { view: 'none', good, scrap: p.scrap, note, at: p.at ?? undefined });
        });
        done.push({ stepId: s.id, label: p.label, good, scrap: p.scrap, wave: waves });
      } catch (e) {
        refused.push({ stepId: s.id, label: p.label, reason: reasonOf(e) });
      }
    }
  }
  if (open.size) {
    const data = await evaluatedTracker(readDb, c.companyId, ctx.releaseIds);
    const now = new Map((data?.steps ?? []).map((s) => [s.id, s]));
    for (const id of open) {
      const s = now.get(id);
      const why = !s ? 'Step not found.' : s._status === 'not_ready' ? `It cannot start yet. ${(s._blockers ?? []).map((b) => b.text).join(' ')}`.trim()
        : s._status === 'on_hold' ? 'It is on hold — resume it first.' : `It is ${String(s._status).replace('_', ' ')}.`;
      refused.push({ stepId: id, label: want.get(id).label, reason: why });
    }
  }
  const rowOf = new Map(plan.map((p) => [p.stepId, p.sheetRow]));
  refused.sort((a, b) => rowOf.get(a.stepId) - rowOf.get(b.stepId));
  const changes = done.map((d) => ({ action: 'record', path: d.label, detail: [d.good ? `good +${d.good}` : null, d.scrap ? `scrap +${d.scrap}` : null].filter(Boolean).join(', '), stepId: d.stepId }));
  const sentence = [
    done.length ? `${plural(done.length, 'step', 'steps')} recorded${waves > 1 ? ` in ${waves} rounds (rows that waited for earlier ones went after them)` : ''}` : 'no step was recorded',
    refused.length ? `${plural(refused.length, 'step was', 'steps were')} refused — each says why` : '',
  ].filter(Boolean).join('; ');
  return answer({ dryRun, problems, changes, summary: { ...summary, recorded: done.length, refusedCount: refused.length, waves, sentence }, done, refused, applied: done.length > 0 });
}
