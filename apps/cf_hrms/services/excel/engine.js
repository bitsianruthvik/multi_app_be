/**
 * engine.js — Excel download, preview and apply, the same for every entity.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.2–§13.4.)
 *
 * AN ENTITY (./entities/*.js) declares:
 *
 *   entity, label, area                     'positions', 'Positions', 'positions'
 *   list                                    which list its download follows (lib/listFilters.js) and how to read it
 *   wholeCompany                            true when its records belong to no department
 *   idsFirst                                true: on an upload, `load` is told the ids in the
 *                                           file's hidden column (env.fileIds) and loads just
 *                                           those records (actuals: rows that are not one
 *                                           table's rows, spec §19.3)
 *   load(db, c, env)   -> state             every list and every current row, read ONCE:
 *                                           { lists: { key: { label, entries: [{ text, key, id? }] } },
 *                                             current: Map<id, { id, seen, label, cells, inScope? }>, … }
 *   columns(state, env) -> [column]         see ./workbook.js for the kinds
 *   check(row, state, env)                  a row's own rules, in memory — pushes sentences to row.problems
 *   checkFile(rows, state, env)             rules between rows: a name twice, a loop
 *   add(db, c, row, state, env)    -> { id, code? }     through the EXISTING service function
 *   change(db, c, row, state, env)                      the same
 *
 * THE ENGINE DOES THE REST, and does it once:
 *   - builds the workbook, with the rows the list's filters show;
 *   - opens an upload and refuses a file that is not this app's, another
 *     company's, another entity's, an older layout, too long;
 *   - matches each row by its hidden `_id`, refuses an id that is not this
 *     company's live record, an id twice, a record changed since the download;
 *   - reads every cell as its column says, compares it with the record, and
 *     says ADD, CHANGE (column, from, to), SAME or PROBLEM;
 *   - applies in ONE transaction, adds first, and NEVER REMOVES: a record that
 *     is not in the file is not looked at.
 *
 * ROUND TRIPS. `load` reads every list once; reading and checking the file is
 * all in memory. What an apply costs after that is the entity's own writes.
 *
 * A NEW ROW CANNOT POINT AT ANOTHER NEW ROW. A list value is matched by its
 * code, and a new record has no code until it is saved — so "a new department
 * under another new department" is refused plainly: add the first, upload, and
 * download again. (Said on the How to use sheet.)
 */
import { invalid, conflict, HrmsError } from '../../lib/errors.js';
import { filterRows, LIST_SPECS } from '../../lib/listFilters.js';
import { buildWorkbook, openWorkbook, readCell, cellOf, editable, MAX_DATA_ROWS, SCHEMA_VERSION } from './workbook.js';
import { ENTITIES } from './entities/index.js';
import { asBatch } from '../../lib/batch.js';

/** How many NEW rows one file may add, unless the entity says otherwise (`maxAdds`). Changes are not limited. */
export const DEFAULT_MAX_ADDS = 500;
/** How many rows one file may CHANGE (two or three round trips each). */
export const DEFAULT_MAX_CHANGES = 500;

export const entityOf = (name) => {
  const def = ENTITIES.find((e) => e.entity === name);
  if (!def) throw new HrmsError(404, 'NOT_FOUND', 'There is no Excel file for that.');
  return def;
};

const iso = (v) => { if (v == null || v === '') return ''; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString(); };
const show = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/** A state's lists, as the workbook wants them (values) and as the reader wants them (byKey). */
function listsOf(state) {
  const out = {};
  for (const [key, list] of Object.entries(state.lists ?? {})) {
    const byKey = new Map();
    for (const e of list.entries) {
      byKey.set(String(e.key ?? e.text).trim().toLowerCase(), e);
      if (!byKey.has(e.text.toLowerCase())) byKey.set(e.text.toLowerCase(), e);
    }
    out[key] = { label: list.label, values: list.entries.map((e) => e.text), byKey };
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Download
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /excel/:entity/workbook?<the list's filters>&blank=1
 * @param env { can(tag), scope: { all, departmentIds }, userName, company: { id, name }, query }
 */
export async function downloadWorkbook(db, c, def, env) {
  const state = await def.load(db, c, env);
  const columns = def.columns(state, env);
  let rows = [];
  if (!['1', 'true', 'yes'].includes(String(env.query?.blank ?? '').toLowerCase())) {
    let ids = null;
    // What the list shows with these filters — the same spec, the same function (lib/listFilters.js).
    if (def.list) {
      const listed = await def.list.read(db, c, env);
      ids = new Set((await filterRows(db, c.companyId, listed, env.query ?? {}, LIST_SPECS[def.list.name])).map((r) => r.id));
    }
    rows = [...state.current.values()]
      .filter((r) => r.inScope !== false && (!ids || ids.has(r.id)))
      .map((r) => ({ id: r.id, seen: iso(r.seen), cells: r.cells }));
  }
  const built = await buildWorkbook({
    entity: def.entity, label: def.label, fileLabel: def.fileLabel, company: env.company, userName: env.userName,
    intro: def.intro ?? [], rules: def.rules ?? [], columns, lists: listsOf(state), rows,
  });
  return { fileName: built.fileName, mimeType: built.mimeType, contentBase64: built.buffer.toString('base64'), rows: rows.length };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading an upload
 * ══════════════════════════════════════════════════════════════════════════ */

function decode(body) {
  const raw = body?.contentBase64 ?? body?.dataBase64 ?? body?.content;
  if (typeof raw !== 'string' || !raw) throw invalid('NO_FILE', 'No file was received.');
  const text = raw.includes('base64,') ? raw.slice(raw.indexOf('base64,') + 7) : raw;
  // Longer than a 5 MB file can be in base64: not decoded at all.
  if (text.length > 8 * 1024 * 1024) return { buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x50), tooBig: true };
  return { buffer: Buffer.from(text, 'base64') };
}

/**
 * Everything the preview says, and everything the apply acts on. Changes nothing.
 * @returns {{ fileProblems, rows, summary, state }}
 */
async function analyse(db, c, def, body, env) {
  const fileName = String(body?.fileName ?? '').slice(0, 255);
  const { buffer } = decode(body);
  const opened = await openWorkbook(buffer, fileName);
  const fileProblems = [...opened.fileProblems];
  const answer = (rows = [], state = null) => ({
    fileProblems, rows, state,
    summary: { add: rows.filter((r) => r.action === 'ADD').length, change: rows.filter((r) => r.action === 'CHANGE').length, same: rows.filter((r) => r.action === 'SAME').length, problems: rows.filter((r) => r.action === 'PROBLEM').length },
  });
  if (fileProblems.length) return answer();

  // ── whose file is this ────────────────────────────────────────────────────
  const meta = opened.meta ?? {};
  if (!opened.signatureOk) {
    fileProblems.push('This workbook was not made by this app, or its hidden sheet has been changed. Download a fresh file and fill that in.');
    return answer();
  }
  if (Number(meta.companyId) !== Number(c.companyId)) { fileProblems.push('This file was downloaded for another company. Download a fresh file here.'); return answer(); }
  if (meta.entity !== def.entity) {
    const other = ENTITIES.find((e) => e.entity === meta.entity);
    fileProblems.push(`This is the ${other?.label ?? meta.entity} file. Upload it on that screen — this one takes the ${def.label} file.`);
    return answer();
  }
  if (Number(meta.schemaVersion) !== SCHEMA_VERSION) { fileProblems.push('This file was downloaded with an older layout. Download a fresh file and fill that in.'); return answer(); }

  // An entity whose records are named by the file reads only those (one pass over the hidden column, in memory).
  let fileIds = null;
  if (def.idsFirst) {
    fileIds = [];
    for (let n = 2; n <= opened.lastRow && fileIds.length <= MAX_DATA_ROWS; n += 1) {
      const idCell = cellOf(opened.sheet.getRow(n).getCell(1));
      const id = idCell.kind === 'number' ? idCell.value : Number(idCell.value);
      if (idCell.kind !== 'empty' && Number.isInteger(id) && id > 0) fileIds.push(id);
    }
  }
  const state = await def.load(db, c, fileIds ? { ...env, fileIds } : env);
  const columns = def.columns(state, env);
  const lists = listsOf(state);
  const missing = columns.filter((col) => editable(col) && !opened.columnAt.has(col.header));
  if (missing.length) { fileProblems.push(`The Data sheet has lost ${missing.length === 1 ? 'a column' : 'columns'}: ${missing.map((m) => m.header).join(', ')}. Download a fresh file and fill that in.`); return answer(); }

  // ── the rows that hold anything ───────────────────────────────────────────
  const sheet = opened.sheet;
  const found = [];
  for (let n = 2; n <= opened.lastRow; n += 1) {
    const r = sheet.getRow(n);
    const idCell = cellOf(r.getCell(1));
    const filled = columns.some((col) => editable(col) && cellOf(r.getCell(opened.columnAt.get(col.header))).kind !== 'empty');
    if (idCell.kind === 'empty' && !filled) continue;
    found.push({ n, r, idCell });
    if (found.length > MAX_DATA_ROWS) break;
  }
  if (found.length > MAX_DATA_ROWS) { fileProblems.push(`The file has more than ${MAX_DATA_ROWS.toLocaleString('en-IN')} rows. Upload it in parts.`); return answer(); }

  const seenIds = new Map();
  for (const f of found) if (f.idCell.kind !== 'empty') seenIds.set(String(f.idCell.value), (seenIds.get(String(f.idCell.value)) ?? 0) + 1);

  const rows = found.map(({ n, r, idCell }) => {
    const row = { row: n, action: 'SAME', label: '', changes: [], problems: [], id: null, isNew: true, values: {}, entries: {}, current: null, sent: new Set() };
    // ── which record ──
    if (idCell.kind !== 'empty') {
      const id = idCell.kind === 'number' ? idCell.value : Number(idCell.value);
      row.isNew = false;
      const current = Number.isInteger(id) ? state.current.get(id) : null;
      if (seenIds.get(String(idCell.value)) > 1) row.problems.push('This record is in the file more than once. Keep one row for it.');
      if (!current) row.problems.push('This row belongs to a record that is not in this company any more (it was removed, or the hidden column was changed). Delete the row, or download a fresh file.');
      else {
        row.id = id;
        row.current = current;
        row.label = current.label;
        if (current.inScope === false) row.problems.push('This record is outside your department. Your access covers your own department and the ones below it.');
        const seen = cellOf(r.getCell(2));
        const was = seen.kind === 'date' ? seen.value.toISOString() : String(seen.value ?? '');
        if (!was) row.problems.push('The hidden columns of this row were changed. Download a fresh file.');
        else if (iso(current.seen) > was) row.problems.push('This record was changed in the app since this file was downloaded — download again.');
      }
    }
    // ── its cells ──
    for (const col of columns) {
      if (!editable(col)) continue;
      const read = readCell(r.getCell(opened.columnAt.get(col.header)), col, lists);
      // A required cell that is empty on the record too is not this file's doing: the row may still be changed elsewhere.
      if (read.problem && read.empty && row.current && (row.current.cells[col.key] == null || row.current.cells[col.key] === '')) { row.values[col.key] = null; continue; }
      if (read.problem) { row.problems.push(read.problem); continue; }
      row.values[col.key] = read.value;
      if (read.entry) row.entries[col.key] = read.entry;
    }
    if (row.isNew) row.label = def.labelOf?.(row) ?? show(row.values.name ?? row.values.title) ?? '';
    return row;
  });

  // ── the entity's own rules, in memory ─────────────────────────────────────
  for (const row of rows) {
    if (row.isNew || row.current) def.check?.(row, state, env);
    if (!row.isNew && row.current) {
      for (const col of columns) {
        if (!editable(col) || !(col.key in row.values) || col.newOnly) continue;
        const from = show(row.current.cells[col.key] === true ? 'Yes' : row.current.cells[col.key] === false ? 'No' : row.current.cells[col.key]);
        const to = show(row.values[col.key]);
        if (from !== to) row.changes.push({ column: col.header, key: col.key, from, to });
      }
    } else if (row.isNew) {
      for (const col of columns) if (editable(col) && show(row.values[col.key]) !== '' && !(col.kind === 'yesno' && row.values[col.key] === 'No')) row.changes.push({ column: col.header, key: col.key, from: '', to: show(row.values[col.key]) });
    }
  }
  def.checkFile?.(rows, state, env);
  for (const row of rows) {
    row.action = row.problems.length ? 'PROBLEM' : (row.isNew ? 'ADD' : (row.changes.length ? 'CHANGE' : 'SAME'));
  }
  const whole = def.fileRules?.(rows, state, env) ?? [];
  fileProblems.push(...whole);
  // A new record is written through its service, a row at a time, and each costs round trips: a file
  // that adds too many at once would outlast the request that carries it.
  const adding = rows.filter((r) => r.isNew).length;
  const most = def.maxAdds ?? DEFAULT_MAX_ADDS;
  if (adding > most) fileProblems.push(`This file adds ${adding} ${def.label.toLowerCase()}. Add up to ${most} at a time: upload it in parts.`);
  const changing = rows.filter((r) => r.action === 'CHANGE').length;
  const mostChanges = def.maxChanges ?? DEFAULT_MAX_CHANGES;
  if (changing > mostChanges) fileProblems.push(`This file changes ${changing} ${def.label.toLowerCase()}. Change up to ${mostChanges} at a time: upload it in parts.`);
  return answer(rows, state);
}

const publicRow = (r) => ({ row: r.row, action: r.action, label: r.label ?? '', changes: r.changes.map(({ column, from, to }) => ({ column, from, to })), problems: r.problems });

/** POST /excel/:entity/preview { fileName, contentBase64 } — reads, changes nothing. */
export async function previewUpload(db, c, def, body, env) {
  const a = await analyse(db, c, def, body, env);
  // A whole-file problem is the only thing said about the file: no rows, no counts to act on.
  if (a.fileProblems.length) return { entity: def.entity, fileName: String(body?.fileName ?? ''), summary: { add: 0, change: 0, same: 0, problems: 0 }, rows: [], fileProblems: a.fileProblems };
  return { entity: def.entity, fileName: String(body?.fileName ?? ''), summary: a.summary, rows: a.rows.map(publicRow), fileProblems: a.fileProblems };
}

/**
 * POST /excel/:entity/apply { fileName, contentBase64, expect: { add, change }, skipProblemRows? }
 * Runs on the caller's transaction: everything, or nothing.
 */
export async function applyUpload(db, c, def, body, env) {
  const a = await analyse(db, c, def, body, env);
  if (a.fileProblems.length) throw invalid('FILE_PROBLEM', a.fileProblems[0], { problems: a.fileProblems });
  const expect = body?.expect ?? {};
  if (Number(expect.add) !== a.summary.add || Number(expect.change) !== a.summary.change) {
    throw conflict('PREVIEW_STALE', `The file now gives ${a.summary.add} to add and ${a.summary.change} to change — not what the preview showed. Look at the preview again.`, { detail: { summary: a.summary } });
  }
  const skip = body?.skipProblemRows === true;
  if (a.summary.problems && !skip) {
    throw invalid('HAS_PROBLEMS', `${a.summary.problems} ${a.summary.problems === 1 ? 'row has a problem' : 'rows have problems'}. Put ${a.summary.problems === 1 ? 'it' : 'them'} right, or apply the good rows and skip ${a.summary.problems === 1 ? 'it' : 'them'}.`, {
      problems: a.rows.filter((r) => r.action === 'PROBLEM').slice(0, 20).map((r) => `Row ${r.row}: ${r.problems[0]}`),
      detail: { summary: a.summary },
    });
  }
  const adds = a.rows.filter((r) => r.action === 'ADD');
  const changes = a.rows.filter((r) => r.action === 'CHANGE');
  const run = { fileName: String(body?.fileName ?? '').slice(0, 255) };
  const issuedCodes = [];
  const each = async (rows, fn) => {
    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one record at a time, through the service that owns its rules
        await fn(row);
      } catch (err) {
        if (!(err?.status >= 400 && err.status < 500)) throw err;
        // A rule only the service knows. The transaction is the caller's: nothing of this file is kept.
        // "Some fields need attention" says nothing: the first of the service's own problems does.
        const said = /need attention|cannot be saved yet/i.test(err.message) && err.problems?.length ? err.problems[0] : err.message;
        throw new HrmsError(err.status === 409 ? 409 : 422, 'APPLY_FAILED', `Row ${row.row}${row.label ? ` (${row.label})` : ''}: ${said} Nothing of this file was saved.`, {
          problems: [`Row ${row.row}: ${err.message}`, ...(err.problems ?? []).map((p) => `Row ${row.row}: ${p}`)], detail: { row: row.row, code: err.code ?? null },
        });
      }
    }
  };
  // A bulk run: the services skip the read-back they end with, and the code rules are read once (lib/batch.js).
  await asBatch(db, async () => {
    await each(adds, async (row) => {
      const made = await def.add(db, c, row, a.state, { ...env, run });
      issuedCodes.push({ row: row.row, code: made?.code ?? null });
    });
    await each(changes, (row) => def.change(db, c, row, a.state, { ...env, run }));
    await def.afterApply?.(db, c, { adds, changes, issuedCodes }, a.state, { ...env, run });
  });
  return { added: adds.length, changed: changes.length, skipped: a.summary.problems, issuedCodes: issuedCodes.filter((x) => x.code) };
}

/** GET /excel/entities -> [{ entity, label, area, canDownload, canUpload }] */
export function listEntities(env) {
  return ENTITIES.map((d) => ({
    entity: d.entity, label: d.label, area: d.area,
    canDownload: env.can(d.viewRight),
    canUpload: env.can(d.uploadRight) && (env.scope.all || !d.wholeCompany),
  }));
}

export default { entityOf, downloadWorkbook, previewUpload, applyUpload, listEntities };
