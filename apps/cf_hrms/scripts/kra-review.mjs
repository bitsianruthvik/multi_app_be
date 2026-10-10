/**
 * The KRA grouping, as a workbook a person can review — and back again.
 *
 * `<chart>.kras.json` says which outcome area (KRA) each responsibility and KPI
 * of a role sits under. It is the source the importer applies, and it is JSON,
 * which nobody at a client should have to edit. So:
 *
 *   node kra-review.mjs export --company=karni [--out=<path.xlsx>] [--source=<chart>] [--kras=<path>]
 *       Writes TM/<Company>_KRA_review.xlsx: a Roles sheet (one row per role,
 *       with its one-sentence purpose), a KRAs sheet (each role's KRAs with
 *       line counts) and a Lines sheet, one row per (role, line):
 *       Role · KRA · Kind · Text · Target · Move to KRA · Comment.
 *
 *   node kra-review.mjs apply --workbook=<path.xlsx> [--apply] [--force] [--source=<chart>] [--kras=<path>]
 *       Reads a reviewed workbook and updates the .kras.json. DRY RUN unless
 *       --apply: it prints every change and writes nothing.
 *
 * WHAT A REVIEWER CAN DO, and nothing else:
 *   - Lines sheet, "Move to KRA": type the name of another KRA of the same role
 *     to move the line there. A name the role does not have yet makes a NEW KRA
 *     (added after the role's others). An ungrouped line (KRA blank) is placed
 *     the same way.
 *   - KRAs sheet, "Rename KRA to": a new name for that KRA of that role.
 *     Renaming onto a name the role already has merges the two.
 *   - Roles sheet, "Change purpose to": a new one-sentence purpose for that
 *     role. It replaces the sentence in the file and is marked "reviewed".
 *   - "Comment" anywhere: printed back by `apply`, never stored.
 * Editing Role, KRA, Kind, Text or Target does nothing: this workbook groups, it
 * does not reword. A row whose text no longer matches is reported and skipped.
 *
 * WHERE THE ROWS COME FROM. The lines (role, seats, text, target) are read from
 * the tenant the chart was imported into — read-only — because that is where
 * roles exist as the importer names them. The GROUPING is read from the file,
 * not from the tenant, so the workbook always shows the file as it is now, even
 * if nobody has re-imported since the last edit. A line the file does not place
 * shows with a blank KRA.
 *
 * SAFETY. The workbook records the sha256 of the .kras.json it was made from.
 * `apply` refuses a workbook made from a different version of the file (someone
 * edited the file after the export; --force overrides). --apply keeps the
 * previous file as `<file>.bak` and appends what it did to the file's `history`.
 * The tenant is never written: after --apply, re-import and run the verifier.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { resolveSource, resolveKras, readKras } from './orgChartSource.mjs';

const TM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const MODE = args.find((a) => !a.startsWith('--'));
const arg = (n, d = '') => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const has = (n) => args.includes(`--${n}`);

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase().replace(/[.;,]+$/, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const NO_KRA = '(no KRA yet)';

const ROLES = 'Roles';
const SUMMARY = 'KRAs';
const LINES = 'Lines';
const ABOUT = 'About';
const ROLE_COLS = [
  { header: 'Role', key: 'role', width: 44 },
  { header: 'Seats', key: 'seats', width: 16 },
  { header: 'KRAs', key: 'kras', width: 7 },
  { header: 'Lines', key: 'lines', width: 7 },
  { header: 'Purpose', key: 'purpose', width: 80 },
  { header: 'Basis', key: 'basis', width: 12 },
  { header: 'Change purpose to', key: 'change', width: 80, edit: true },
  { header: 'Comment', key: 'comment', width: 40, edit: true },
];
const SUMMARY_COLS = [
  { header: 'Role', key: 'role', width: 44 },
  { header: 'Seats', key: 'seats', width: 16 },
  { header: '#', key: 'no', width: 5 },
  { header: 'KRA', key: 'kra', width: 44 },
  { header: 'Responsibilities', key: 'resp', width: 16 },
  { header: 'KPIs', key: 'kpi', width: 8 },
  { header: 'Rename KRA to', key: 'rename', width: 36, edit: true },
  { header: 'Comment', key: 'comment', width: 44, edit: true },
];
const LINE_COLS = [
  { header: 'Role', key: 'role', width: 36 },
  { header: 'KRA', key: 'kra', width: 34 },
  { header: 'Kind', key: 'kind', width: 15 },
  { header: 'Text', key: 'text', width: 90 },
  { header: 'Target', key: 'target', width: 34 },
  { header: 'Move to KRA', key: 'move', width: 34, edit: true },
  { header: 'Comment', key: 'comment', width: 44, edit: true },
];

/** A cell as plain text, whatever Excel made of it (rich text, a formula result, a number). */
const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return norm(v.richText.map((r) => r.text).join(''));
    if (v.text != null) return norm(v.text);
    if (v.result != null) return norm(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return norm(v);
};

const readJson = (v) => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };

function kraFileOrDie() {
  const source = resolveSource();
  const file = readKras(resolveKras(source));
  if (!file) throw new Error(`No KRA file beside ${source} (and no --kras=). There is nothing to review yet.`);
  return file;
}

// ================================================================ EXPORT ===
async function exportWorkbook() {
  const target = resolveTarget();
  announce(target);
  const kf = kraFileOrDie();
  const slug = arg('company', 'karni');
  const out = arg('out') || path.join(TM_ROOT, `${slug.charAt(0).toUpperCase()}${slug.slice(1)}_KRA_review.xlsx`);

  const conn = await mysql.createConnection(target.cfg);
  const q = async (sql, p = []) => (await conn.execute(sql, p))[0];
  const [[company]] = await conn.query('SELECT id, name FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company with slug "${slug}".`);
  const c = company.id;
  const roles = await q('SELECT id, title FROM hrms_roles WHERE company_id=? AND deleted_at IS NULL', [c]);
  const seats = await q('SELECT role_id, position_code FROM hrms_positions WHERE company_id=? AND deleted_at IS NULL ORDER BY position_code', [c]);
  const resp = await q(
    `SELECT a.role_id, a.sequence, d.description AS text
       FROM hrms_role_responsibility_assignments a
       JOIN hrms_responsibility_definitions d ON d.company_id=a.company_id AND d.id=a.responsibility_definition_id
      WHERE a.company_id=? AND a.deleted_at IS NULL ORDER BY a.role_id, a.sequence, a.id`, [c]);
  const kpis = await q(
    `SELECT a.role_id, a.sequence, d.name AS text, a.target_value
       FROM hrms_role_kpi_assignments a
       JOIN hrms_kpi_definitions d ON d.company_id=a.company_id AND d.id=a.kpi_definition_id
      WHERE a.company_id=? AND a.deleted_at IS NULL ORDER BY a.role_id, a.sequence, a.id`, [c]);
  await conn.end();

  // The file's grouping, found the way the importer finds it: title, then seats.
  const seatSig = (ids) => [...new Set(ids)].sort().join(',');
  const entryByTitle = new Map(kf.roles.map((e) => [normKey(e.role), e]));
  const entryBySeats = new Map(kf.roles.filter((e) => Array.isArray(e.seats) && e.seats.length).map((e) => [seatSig(e.seats), e]));

  const roleRows = [];
  const summary = [];
  const lines = [];
  const empty = [];
  const usedEntries = new Set();
  let ungrouped = 0;
  for (const r of [...roles].sort((a, b) => a.title.localeCompare(b.title))) {
    const roleSeats = seats.filter((s) => s.role_id === r.id).map((s) => s.position_code);
    const mine = [
      ...resp.filter((x) => x.role_id === r.id).map((x) => ({ kind: 'Responsibility', k: 'R', text: x.text, target: '' })),
      ...kpis.filter((x) => x.role_id === r.id).map((x) => ({ kind: 'KPI', k: 'K', text: x.text, target: String(readJson(x.target_value) ?? '') })),
    ];
    const entry = entryByTitle.get(normKey(r.title)) ?? entryBySeats.get(seatSig(roleSeats)) ?? null;
    if (entry) usedEntries.add(entry);
    // Every role has a row on the Roles sheet, duties or not: the purpose is
    // the one thing a role with no duties still has to be reviewed for.
    const roleRow = { role: r.title, seats: roleSeats.join(', '), kras: 0, lines: mine.length, purpose: typeof entry?.purpose === 'string' ? entry.purpose.trim() : '', basis: norm(entry?.purposeBasis) };
    roleRows.push(roleRow);
    if (!mine.length) { empty.push({ role: r.title, seats: roleSeats.join(', ') }); continue; }
    const where = new Map();                  // k|line -> index of the KRA in the entry
    (entry?.kras ?? []).forEach((k, i) => {
      for (const t of (k.responsibilities ?? [])) if (!where.has(`R|${normKey(t)}`)) where.set(`R|${normKey(t)}`, i);
      for (const t of (k.kpis ?? [])) if (!where.has(`K|${normKey(t)}`)) where.set(`K|${normKey(t)}`, i);
    });
    const buckets = (entry?.kras ?? []).map((k) => ({ name: norm(k.name), rows: [] }));
    const loose = [];
    for (const l of mine) {
      const i = where.get(`${l.k}|${normKey(l.text)}`);
      (i === undefined ? loose : buckets[i].rows).push(l);
    }
    let no = 0;
    for (const b of buckets) {
      // A KRA of the file with no line left in the chart is not shown: the
      // importer does not create it either. It is listed on the About sheet.
      if (!b.rows.length) continue;
      no++;
      roleRow.kras = no;
      summary.push({ role: r.title, seats: roleSeats.join(', '), no, kra: b.name, resp: b.rows.filter((x) => x.k === 'R').length, kpi: b.rows.filter((x) => x.k === 'K').length });
      // Responsibilities first, then KPIs, each in the role's own order.
      for (const l of [...b.rows.filter((x) => x.k === 'R'), ...b.rows.filter((x) => x.k === 'K')]) lines.push({ role: r.title, kra: b.name, kind: l.kind, text: l.text, target: l.target });
    }
    if (loose.length) {
      ungrouped += loose.length;
      summary.push({ role: r.title, seats: roleSeats.join(', '), no: '', kra: NO_KRA, resp: loose.filter((x) => x.k === 'R').length, kpi: loose.filter((x) => x.k === 'K').length });
      for (const l of loose) lines.push({ role: r.title, kra: '', kind: l.kind, text: l.text, target: l.target });
    }
  }
  const staleRoles = kf.roles.filter((e) => !usedEntries.has(e)).map((e) => norm(e.role));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF_HRMS kra-review.mjs';
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map((col) => ({ header: col.header, key: col.key, width: col.width }));
    for (const row of rows) ws.addRow(row);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    ws.getRow(1).height = 22;
    cols.forEach((col, i) => {
      ws.getCell(1, i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col.edit ? 'FFB45309' : 'FF4338CA' } };
    });
    let prevRole = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      row.alignment = { vertical: 'top', wrapText: true };
      const role = row.getCell(1).value;
      cols.forEach((col, i) => {
        const cell = row.getCell(i + 1);
        if (col.edit) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        // A rule above the first row of each role, so a long sheet reads in blocks.
        if (role !== prevRole && r > 2) cell.border = { top: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
      });
      prevRole = role;
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: cols.length } };
    return ws;
  };
  sheet(ROLES, ROLE_COLS, roleRows);
  sheet(SUMMARY, SUMMARY_COLS, summary);
  sheet(LINES, LINE_COLS, lines);

  const about = wb.addWorksheet(ABOUT);
  about.columns = [{ width: 26 }, { width: 110 }];
  const aboutRows = [
    ['What this is', `The one-sentence purpose and the key result areas (KRAs) drafted for each role of ${company.name}, and the responsibilities and KPIs grouped under the KRAs. Review it and send it back; your changes are read from the amber columns.`],
    ['To change a purpose', 'On the Roles sheet, type the sentence you want in "Change purpose to". One sentence saying why the role exists; it opens the job description. "Basis" says what the draft was written from: "duties" (the role\'s own duties and KRAs) or "title only" (the chart gives the role no duties, so the sentence rests on its title, department and reporting line — read these with extra care).'],
    ['To move a line', 'On the Lines sheet, type the KRA it should sit under in "Move to KRA". Use the name of another KRA of the same role (see the KRAs sheet), or type a new name to create a KRA for that role.'],
    ['To rename a KRA', 'On the KRAs sheet, type the new name in "Rename KRA to". It renames that KRA for that role only. Renaming onto a name the role already has merges the two.'],
    ['Comments', 'Write anything in "Comment". Comments are read back and listed, not stored.'],
    ['Please do not edit', 'Role, Seats, Purpose, Basis, KRA, Kind, Text and Target. This review only groups: no responsibility or KPI is reworded, merged or dropped here. A changed text is skipped.'],
    ['KRAs are per role', 'Two roles may both have a KRA called "Quality"; they are unrelated. Renaming one does not rename the other.'],
    ['Roles', `${new Set(summary.map((s) => s.role)).size} with duties, ${summary.filter((s) => s.kra !== NO_KRA).length} KRAs, ${lines.length} lines (${ungrouped} not yet under a KRA).`],
    ['Roles with no duties', empty.length ? `${empty.length} roles have no responsibilities or KPIs in the chart and so no KRAs: ${empty.map((e) => e.role).join(', ')}.` : 'None.'],
    ['In the file, not in the chart', staleRoles.length ? `Roles the KRA file names that this tenant does not have: ${staleRoles.join(', ')}.` : 'Nothing.'],
    ['Company', `${company.name} (${slug})`],
    ['KRA file', kf.fileName],
    ['KRA file sha256', kf.hash],
    ['Made on', new Date().toISOString().slice(0, 10)],
  ];
  for (const r of aboutRows) about.addRow(r);
  about.getColumn(1).font = { bold: true };
  about.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  await wb.xlsx.writeFile(out);
  console.log(`  wrote ${out}`);
  console.log(`  ${new Set(summary.map((s) => s.role)).size} roles, ${summary.filter((s) => s.kra !== NO_KRA).length} KRAs, ${lines.length} lines (${ungrouped} ungrouped), ${empty.length} roles without duties`);
  console.log(`  ${roleRows.length} roles on the Roles sheet, ${roleRows.filter((x) => x.purpose).length} with a purpose (${roleRows.filter((x) => x.basis === 'title only').length} from the title only)`);
  console.log(`  made from ${kf.fileName} sha256 ${kf.hash.slice(0, 12)}…`);
}

// ================================================================= APPLY ===
async function applyWorkbook() {
  const wbPath = arg('workbook');
  if (!wbPath || !fs.existsSync(wbPath)) throw new Error('apply needs --workbook=<path to the reviewed .xlsx>.');
  const kf = kraFileOrDie();
  const APPLY = has('apply');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wbPath);
  const wsR = wb.getWorksheet(ROLES);
  const wsS = wb.getWorksheet(SUMMARY);
  const wsL = wb.getWorksheet(LINES);
  const wsA = wb.getWorksheet(ABOUT);
  if (!wsR || !wsS || !wsL) throw new Error(`${wbPath} is not a KRA review workbook of the current layout: it needs the sheets "${ROLES}", "${SUMMARY}" and "${LINES}". Export a fresh one.`);

  // Columns by HEADER, so a reviewer who reorders or inserts a column breaks nothing.
  const table = (ws, cols) => {
    const at = new Map();
    ws.getRow(1).eachCell((cell, i) => at.set(cellText(cell.value).toLowerCase(), i));
    const missing = cols.filter((col) => !at.has(col.header.toLowerCase())).map((col) => col.header);
    if (missing.length) throw new Error(`Sheet "${ws.name}" has lost its column(s) ${missing.join(', ')}.`);
    const rows = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const o = { row: r };
      for (const col of cols) o[col.key] = cellText(ws.getRow(r).getCell(at.get(col.header.toLowerCase())).value);
      if (Object.entries(o).some(([k, v]) => k !== 'row' && v)) rows.push(o);
    }
    return rows;
  };
  const rRows = table(wsR, ROLE_COLS);
  const sRows = table(wsS, SUMMARY_COLS);
  const lRows = table(wsL, LINE_COLS);

  let madeFrom = null;
  wsA?.eachRow((row) => { if (cellText(row.getCell(1).value) === 'KRA file sha256') madeFrom = cellText(row.getCell(2).value); });
  if (madeFrom !== kf.hash) {
    const msg = `This workbook was made from a different version of ${kf.fileName} (workbook ${madeFrom ? `${madeFrom.slice(0, 12)}…` : 'records none'}, file is ${kf.hash.slice(0, 12)}…). `
      + 'The file was edited after the export, so "KRA" in the workbook may no longer be where a line sits.';
    if (!has('force')) throw new Error(`${msg} Export again, or pass --force to apply the moves by name anyway.`);
    console.log(`  WARNING: ${msg} Applying anyway (--force).`);
  }

  const data = JSON.parse(kf.text);
  const entryOf = new Map(data.roles.map((e) => [normKey(e.role), e]));
  const seatsOf = new Map([...sRows, ...rRows].map((s) => [normKey(s.role), s.seats.split(',').map(norm).filter(Boolean)]));
  const kraOf = (entry, name) => (entry.kras ?? []).find((k) => normKey(k.name) === normKey(name)) ?? null;
  const listOf = (kra, kind) => { const key = kind === 'KPI' ? 'kpis' : 'responsibilities'; if (!Array.isArray(kra[key])) kra[key] = []; return kra[key]; };
  const findLine = (entry, kind, text) => {
    for (const k of (entry.kras ?? [])) {
      const list = (kind === 'KPI' ? k.kpis : k.responsibilities) ?? [];
      const i = list.findIndex((t) => normKey(t) === normKey(text));
      if (i >= 0) return { kra: k, list, i };
    }
    return null;
  };

  const changes = { purposes: [], moves: [], placed: [], newKras: [], renames: [], merges: [], removed: [], skipped: [], comments: [] };

  // ---- 0. purposes -------------------------------------------------------
  for (const r of rRows) {
    if (r.comment) changes.comments.push(`Roles row ${r.row} — ${r.role}: ${r.comment}`);
    if (!r.change) continue;
    let entry = entryOf.get(normKey(r.role));
    if (!entry) {
      entry = { role: r.role, seats: seatsOf.get(normKey(r.role)) ?? [], kras: [] };
      data.roles.push(entry);
      entryOf.set(normKey(r.role), entry);
    }
    if ((entry.purpose ?? '').trim() === r.change) continue;
    changes.purposes.push(`${entry.role}: "${entry.purpose ?? '(none)'}"  ->  "${r.change}"`);
    entry.purpose = r.change;
    // A person wrote this one, so it no longer rests on the draft's basis.
    entry.purposeBasis = 'reviewed';
  }
  // Renames asked for, by role: old name -> new name. Read before the moves so
  // a "Move to KRA" may use either the old or the new name of a renamed KRA.
  const renameOf = new Map();
  for (const s of sRows) {
    if (s.comment) changes.comments.push(`Summary row ${s.row} — ${s.role} / ${s.kra}: ${s.comment}`);
    if (!s.rename || s.kra === NO_KRA || normKey(s.rename) === normKey(s.kra) && s.rename === s.kra) continue;
    if (!renameOf.has(normKey(s.role))) renameOf.set(normKey(s.role), new Map());
    renameOf.get(normKey(s.role)).set(normKey(s.kra), s.rename);
  }

  // ---- 1. moves --------------------------------------------------------
  for (const l of lRows) {
    if (l.comment) changes.comments.push(`Lines row ${l.row} — ${l.role} / ${clip(l.text, 60)}: ${l.comment}`);
    if (!l.move) continue;
    if (l.kind !== 'Responsibility' && l.kind !== 'KPI') { changes.skipped.push(`Lines row ${l.row}: Kind "${l.kind}" is neither Responsibility nor KPI.`); continue; }
    let entry = entryOf.get(normKey(l.role));
    if (!entry) {
      // A role the file has never grouped (all its lines ungrouped so far).
      if (!seatsOf.has(normKey(l.role))) { changes.skipped.push(`Lines row ${l.row}: role "${l.role}" is not in the file or on the Summary sheet.`); continue; }
      entry = { role: l.role, seats: seatsOf.get(normKey(l.role)), kras: [] };
      data.roles.push(entry);
      entryOf.set(normKey(l.role), entry);
    }
    const at = findLine(entry, l.kind, l.text);
    if (!at && l.kra) { changes.skipped.push(`Lines row ${l.row}: "${clip(l.text, 70)}" is not under any KRA of "${l.role}" in the file — the text was edited, or the file moved on. Skipped.`); continue; }
    // The name typed: an existing KRA, or the NEW name of one being renamed, or a new KRA.
    const renames = renameOf.get(normKey(l.role));
    const renamedFrom = renames ? [...renames].find(([, to]) => normKey(to) === normKey(l.move))?.[0] : null;
    let dest = kraOf(entry, l.move) ?? (renamedFrom ? kraOf(entry, renamedFrom) : null);
    if (dest && at && dest === at.kra) continue;                       // already there
    if (!dest) {
      dest = { name: l.move, responsibilities: [] };
      entry.kras.push(dest);
      changes.newKras.push(`${l.role}: new KRA "${l.move}"`);
    }
    if (at) {
      const [text] = at.list.splice(at.i, 1);
      listOf(dest, l.kind).push(text);
      changes.moves.push(`${l.role}: ${l.kind} "${clip(text, 70)}"  ${at.kra.name} -> ${dest.name}`);
    } else {
      listOf(dest, l.kind).push(l.text);
      changes.placed.push(`${l.role}: ${l.kind} "${clip(l.text, 70)}"  (ungrouped) -> ${dest.name}`);
    }
  }

  // ---- 2. renames, and merges where the new name is already taken --------
  for (const [roleKey, renames] of renameOf) {
    const entry = entryOf.get(roleKey);
    if (!entry) { changes.skipped.push(`Summary: role "${roleKey}" is not in the file; its renames were skipped.`); continue; }
    for (const [fromKey, to] of renames) {
      const kra = kraOf(entry, fromKey);
      if (!kra) { changes.skipped.push(`Summary: "${entry.role}" has no KRA "${fromKey}" in the file; rename to "${to}" skipped.`); continue; }
      const other = kraOf(entry, to);
      if (other && other !== kra) {
        for (const t of (kra.responsibilities ?? [])) listOf(other, 'Responsibility').push(t);
        for (const t of (kra.kpis ?? [])) listOf(other, 'KPI').push(t);
        kra.responsibilities = []; kra.kpis = [];
        changes.merges.push(`${entry.role}: "${kra.name}" merged into "${other.name}"`);
      } else if (kra.name !== to) {
        changes.renames.push(`${entry.role}: "${kra.name}" -> "${to}"`);
        kra.name = to;
      }
    }
  }

  // ---- 3. a KRA left with nothing is removed -----------------------------
  for (const entry of data.roles) {
    const keep = [];
    for (const k of (entry.kras ?? [])) {
      const n = (k.responsibilities?.length ?? 0) + (k.kpis?.length ?? 0);
      if (!n) { changes.removed.push(`${entry.role}: "${k.name}" is left with no line and was removed`); continue; }
      if (Array.isArray(k.kpis) && !k.kpis.length) delete k.kpis;
      keep.push(k);
    }
    entry.kras = keep;
  }

  const total = changes.purposes.length + changes.moves.length + changes.placed.length + changes.renames.length + changes.merges.length;
  const say = (title, list) => { if (list.length) { console.log(`\n  ${title} (${list.length})`); list.forEach((x) => console.log(`    ${x}`)); } };
  console.log(`\n  ${APPLY ? 'APPLYING' : 'DRY RUN — nothing written'}: ${wbPath} -> ${kf.file}`);
  say('Purpose changed', changes.purposes);
  say('Moved to another KRA', changes.moves);
  say('Placed under a KRA (was ungrouped)', changes.placed);
  say('New KRAs', changes.newKras);
  say('Renamed', changes.renames);
  say('Merged', changes.merges);
  say('Removed because empty', changes.removed);
  say('SKIPPED — read these', changes.skipped);
  say('Reviewer comments', changes.comments);
  if (!total) { console.log('\n  No changes asked for.'); return; }
  if (!APPLY) { console.log(`\n  ${total} change(s). Run again with --apply to write them.`); return; }

  data.history = Array.isArray(data.history) ? data.history : [];
  data.history.push({
    on: new Date().toISOString().slice(0, 10), by: 'kra-review.mjs apply', workbook: path.basename(wbPath),
    purposes: changes.purposes.length, moved: changes.moves.length, placed: changes.placed.length, newKras: changes.newKras.length,
    renamed: changes.renames.length, merged: changes.merges.length, removedEmpty: changes.removed.length,
  });
  fs.copyFileSync(kf.file, `${kf.file}.bak`);
  fs.writeFileSync(kf.file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\n  wrote ${kf.file} (previous version kept as ${path.basename(kf.file)}.bak)`);
  console.log('  The tenant is unchanged. Re-import the chart and run verify-against-source.mjs to apply and prove it.');
}

const run = MODE === 'export' ? exportWorkbook : MODE === 'apply' ? applyWorkbook : null;
if (!run) {
  console.error('Usage: node kra-review.mjs export --company=<slug> [--out=<xlsx>]\n       node kra-review.mjs apply --workbook=<xlsx> [--apply] [--force]');
  process.exit(1);
}
run().catch((e) => { console.error(`\n  ${e.message}`); process.exit(1); });
