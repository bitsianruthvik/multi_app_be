/**
 * gapsImportService.js — a day's unaccounted time, out to Excel and back.
 *
 * WHY EXCEL AT ALL. 290 of 294 starts in production are back-entry: the day is
 * reconstructed afterwards, not tapped as it happens. A supervisor writing up
 * eight machines wants one sheet, not eight screens — and the sheet is something
 * they can fill in on the floor, offline, and hand over.
 *
 * WHAT MAKES IT SAFE. The download is not a blank template: it already contains
 * the day's real gaps, one row each, with the machine and the exact window
 * pre-written. The only cells a human touches are the reason and (optionally) a
 * narrower time. Excel's own data validation then constrains those:
 *
 *   - Reason is a DROPDOWN of that company's live catalogue. No free text, so
 *     "brkdown" and "Breakdown" cannot become two categories.
 *   - Start/end are TIME cells bounded to that row's own gap. Excel refuses a
 *     time outside the window before the file is ever uploaded, which is the
 *     only validation a supervisor experiences as helpful rather than as a
 *     rejection after the fact.
 *
 * The server revalidates everything regardless — Excel validation is a
 * convenience for the person, never a guarantee to us. A sheet can be edited
 * with validation stripped, and the import path has to assume it was.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { dayGaps, dayBoundsForResource } from './gapService.js';
import { reasonCatalogue, SCOPE_SITE, SCOPE_MACHINE, SCOPE_TASK } from './gapReasons.js';
import { zonedWallClockToUtc } from './plantTime.js';

const sqlUtc = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

/** An instant as 'HH:MM' at the site. */
function siteHHMM(d, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d));
}

/** Excel stores a time-of-day as a fraction of a day. */
const toExcelTime = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60 + m) / 1440;
};

/** ExcelJS gives back a Date, a number, or a string depending on the cell. */
function readTime(cell) {
  const v = cell?.value;
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const mins = Math.round(v * 1440);
    return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  if (v instanceof Date) {
    // A pure time cell comes back as 1899-12-30T<time>, in UTC.
    return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  }
  const s = String(v.text ?? v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

const cellText = (row, col) => {
  const v = row.getCell(col).value;
  if (v == null) return null;
  if (typeof v === 'object' && v.text) return String(v.text).trim() || null;
  if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim() || null;
  return String(v).trim() || null;
};

// ── export ──────────────────────────────────────────────────────────────────

/**
 * One sheet for one date, covering every machine that has unaccounted time.
 *
 * Machines with a full day are deliberately omitted: a sheet listing rows that
 * need nothing done is a sheet people stop reading.
 */
export async function exportDayGaps(companyId, date, resourceIds = null) {
  const [resources] = await pool.query(
    `SELECT id, name, code FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL
        ${resourceIds?.length ? 'AND id IN (?)' : ''}
      ORDER BY name`,
    resourceIds?.length ? [companyId, resourceIds] : [companyId],
  );

  const catalogue = await reasonCatalogue(companyId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Gaps');

  ws.columns = [
    { header: 'Machine',      key: 'machine', width: 26 },
    { header: 'Gap from',     key: 'gapFrom', width: 11 },
    { header: 'Gap to',       key: 'gapTo',   width: 11 },
    { header: 'Minutes',      key: 'mins',    width: 9 },
    { header: 'What happened', key: 'reason', width: 30 },
    { header: 'From',         key: 'from',    width: 11 },
    { header: 'To',           key: 'to',      width: 11 },
    { header: 'Job (if the reason is about a job)', key: 'job', width: 34 },
    { header: 'Waiting on',   key: 'party',   width: 20 },
    { header: 'Note',         key: 'note',    width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const rows = [];
  for (const r of resources) {
    const day = await dayGaps(companyId, r.id, date);
    if (!day || day.gapMinutes === 0) continue;
    const jobs = day.explained.filter((e) => e.kind === 'work' && e.taskId);
    for (const g of day.gaps) {
      const from = siteHHMM(g.start, day.timezone);
      const to = siteHHMM(g.end, day.timezone);
      const added = ws.addRow({
        machine: `${r.name}${r.code ? ` [${r.code}]` : ''}`,
        gapFrom: from, gapTo: to,
        mins: Math.round((+new Date(g.end) - +new Date(g.start)) / 60000),
        reason: '', from: '', to: '', job: '', party: '', note: '',
      });
      rows.push({ excelRow: added.number, resourceId: r.id, from, to, jobs, tz: day.timezone });
    }
  }

  if (rows.length === 0) {
    ws.addRow({ machine: 'Nothing unaccounted for this date — every machine adds up.' });
  }

  // The three read-only columns are greyed so it is obvious which cells are for
  // the person and which are the system telling them what it already knows.
  for (const r of rows) {
    for (const c of [1, 2, 3, 4]) {
      ws.getRow(r.excelRow).getCell(c).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' },
      };
    }
    // Reason — dropdown of the live catalogue. Not free text: two spellings of
    // "breakdown" would become two categories and neither would be countable.
    ws.getRow(r.excelRow).getCell(5).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: [`"${catalogue.map((x) => x.label.replace(/"/g, "'")).join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Pick from the list',
      error: 'Choose one of the listed reasons so it can be counted.',
    };
    // Times — bounded to THIS row's gap, so an out-of-window time is refused in
    // Excel rather than after upload.
    for (const col of [6, 7]) {
      const cell = ws.getRow(r.excelRow).getCell(col);
      cell.numFmt = 'hh:mm';
      cell.dataValidation = {
        type: 'time', operator: 'between', allowBlank: true,
        formulae: [toExcelTime(r.from), toExcelTime(r.to)],
        showErrorMessage: true,
        errorTitle: 'Outside the gap',
        error: `This gap runs ${r.from}–${r.to}. Leave both blank to use the whole gap.`,
      };
    }
    if (r.jobs.length) {
      ws.getRow(r.excelRow).getCell(8).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`"${r.jobs.map((j) => String(j.label).replace(/[",]/g, ' ')).join(',')}"`],
        showErrorMessage: false,
      };
    }
  }

  // Reference: what each reason means and what it applies to.
  const ref = wb.addWorksheet('Reference — Reasons');
  ref.columns = [
    { header: 'Reason', key: 'l', width: 30 },
    { header: 'Applies to', key: 's', width: 16 },
    { header: 'Effect', key: 'e', width: 52 },
  ];
  ref.getRow(1).font = { bold: true };
  const SCOPE_TEXT = {
    [SCOPE_SITE]: 'The whole plant',
    [SCOPE_MACHINE]: 'This machine',
    [SCOPE_TASK]: 'A job',
  };
  for (const c of catalogue) {
    ref.addRow([c.label, SCOPE_TEXT[c.scope] ?? c.scope,
      c.scope === SCOPE_SITE ? 'One entry covers every machine on site for that time'
        : c.scope === SCOPE_TASK ? 'Follows the job — name the job in the Job column'
          : 'Applies to this machine only']);
  }

  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ header: 'How to fill this in', key: 'i', width: 104 }];
  ins.getRow(1).font = { bold: true };
  [
    'Each row is a period on one machine with nothing recorded against it.',
    '',
    'The grey columns are what the system already knows. Do not edit them.',
    '',
    'Fill in "What happened" from the dropdown. That is the only required cell.',
    'Leave From/To blank and the whole gap is used — which is usually right.',
    'Fill From/To only if the reason covers part of the gap; the rest stays unaccounted.',
    '',
    'If the reason is about a job (an inspection, a drawing hold), pick the job too.',
    '',
    'Leaving a row blank is fine. Unaccounted time is recorded as unknown rather',
    'than guessed at, and an honest blank is better than a wrong reason.',
    '',
    'Times are the wall clock at the plant.',
  ].forEach((t) => ins.addRow([t]));

  return { buffer: await wb.xlsx.writeBuffer(), gapRows: rows.length };
}

// ── import ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate the filled sheet. `commit = false` is the sense check: it
 * reports exactly what would happen and writes nothing.
 *
 * Everything Excel validated is validated again here. A sheet can be edited with
 * validation stripped, or built by hand, so the constraints in the file are a
 * convenience for the person and never a guarantee to us.
 */
export async function importDayGaps(file, companyId, date, enteredBy, { commit = false } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  if (!commit) { /* keep the file for the commit pass */ } else {
    try { fs.unlinkSync(file.path); } catch { /* best effort */ }
  }

  const ws = wb.getWorksheet('Gaps') ?? wb.worksheets[0];
  if (!ws) throw new Error('No "Gaps" sheet in the uploaded file.');

  const catalogue = await reasonCatalogue(companyId);
  const byLabel = new Map(catalogue.map((r) => [r.label.toLowerCase(), r]));
  const byCode = new Map(catalogue.map((r) => [r.code.toLowerCase(), r]));

  const [resources] = await pool.query(
    `SELECT id, name, code FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const resByLabel = new Map();
  for (const r of resources) {
    resByLabel.set(`${r.name}${r.code ? ` [${r.code}]` : ''}`.toLowerCase(), r);
    resByLabel.set(String(r.name).toLowerCase(), r);
  }

  const parsed = [];
  const errors = [];
  const dayCache = new Map();
  const getDay = async (rid) => {
    if (!dayCache.has(rid)) dayCache.set(rid, await dayGaps(companyId, rid, date));
    return dayCache.get(rid);
  };

  const rowsToCheck = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const machine = cellText(row, 1);
    const reasonRaw = cellText(row, 5);
    if (!machine || !reasonRaw) return;   // untouched row — legitimately blank
    rowsToCheck.push({
      n, machine,
      gapFrom: cellText(row, 2), gapTo: cellText(row, 3),
      reasonRaw,
      from: readTime(row.getCell(6)), to: readTime(row.getCell(7)),
      job: cellText(row, 8), party: cellText(row, 9), note: cellText(row, 10),
    });
  });

  for (const r of rowsToCheck) {
    const fail = (m) => errors.push({ row: r.n, message: m });

    const res = resByLabel.get(r.machine.toLowerCase());
    if (!res) { fail(`Machine "${r.machine}" not found.`); continue; }

    const reason = byLabel.get(r.reasonRaw.toLowerCase()) ?? byCode.get(r.reasonRaw.toLowerCase());
    if (!reason) { fail(`"${r.reasonRaw}" is not one of the listed reasons.`); continue; }

    const day = await getDay(res.id);
    if (!day) { fail(`Could not read the day for ${res.name}.`); continue; }

    // Blank times mean the whole gap, which is the common case and the reason
    // the sheet is quick to fill.
    const from = r.from || r.gapFrom;
    const to = r.to || r.gapTo;
    if (!from || !to) { fail('No usable times on this row.'); continue; }

    const fromUtc = zonedWallClockToUtc(date, `${from}:00`, day.timezone);
    let toUtc = zonedWallClockToUtc(date, `${to}:00`, day.timezone);
    if (!fromUtc || !toUtc) { fail('Times are not valid.'); continue; }
    if (toUtc <= fromUtc) {
      const nx = new Date(`${date}T00:00:00Z`); nx.setUTCDate(nx.getUTCDate() + 1);
      toUtc = zonedWallClockToUtc(nx.toISOString().slice(0, 10), `${to}:00`, day.timezone);
    }

    // Must sit inside a still-open gap. Re-checked here because two rows in the
    // same file can claim the same minutes, and Excel cannot know that.
    const inGap = day.gaps.some((g) => fromUtc >= new Date(g.start) && toUtc <= new Date(g.end));
    if (!inGap) {
      fail(`${from}–${to} is not inside an unaccounted period on ${res.name} (it overlaps work, something already explained, or another row in this file).`);
      continue;
    }

    let taskId = null;
    if (reason.scope === SCOPE_TASK) {
      const jobs = day.explained.filter((e) => e.kind === 'work' && e.taskId);
      const match = r.job ? jobs.find((j) => String(j.label).toLowerCase() === r.job.toLowerCase()) : null;
      if (!match) {
        fail(`"${reason.label}" is about a job — put the job name in the Job column${jobs.length ? ` (${jobs.map((j) => j.label).join(', ')})` : ', but no job ran on this machine that day'}.`);
        continue;
      }
      taskId = match.taskId;
    }

    // Consume the span locally so a second row in the same file cannot claim it.
    day.gaps = day.gaps.flatMap((g) => {
      const gs = new Date(g.start); const ge = new Date(g.end);
      if (toUtc <= gs || fromUtc >= ge) return [g];
      const out = [];
      if (fromUtc > gs) out.push({ start: g.start, end: fromUtc.toISOString() });
      if (toUtc < ge) out.push({ start: toUtc.toISOString(), end: g.end });
      return out;
    });

    parsed.push({
      row: r.n, resourceId: res.id, machine: res.name, reason, taskId,
      party: r.party, note: r.note, fromUtc, toUtc,
      fromLabel: from, toLabel: to,
      minutes: Math.round((toUtc - fromUtc) / 60000),
    });
  }

  const preview = parsed.map((p) => ({
    row: p.row, machine: p.machine, reason: p.reason.label,
    scope: p.reason.scope, from: p.fromLabel, to: p.toLabel,
    minutes: p.minutes, ok: true,
  }));

  if (!commit) {
    return { ok: errors.length === 0, applied: 0, preview, errors, wouldApply: parsed.length };
  }
  // ALL-OR-NOTHING, for the same reason the people import is: an operator whose
  // sheet is half-applied will fix it and re-upload the whole file, and the
  // rows that already landed would be applied twice.
  if (errors.length) {
    return { ok: false, applied: 0, preview, errors, wouldApply: 0 };
  }

  let applied = 0;
  for (const p of parsed) {
    const bounds = await dayBoundsForResource(companyId, p.resourceId, date);
    if (p.reason.scope === SCOPE_SITE) {
      await pool.query(
        `INSERT INTO fab_plant_events (company_id, plant_id, event_code, from_ts, to_ts, note, source, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, 'backfill', ?)`,
        [companyId, bounds.plantId, p.reason.code, sqlUtc(p.fromUtc), sqlUtc(p.toUtc), p.note ?? null, enteredBy],
      );
    } else if (p.reason.scope === SCOPE_TASK) {
      await pool.query(
        `INSERT INTO fab_task_holds (company_id, task_id, hold_code, from_ts, to_ts, party, note, source, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill', ?)`,
        [companyId, p.taskId, p.reason.code, sqlUtc(p.fromUtc), sqlUtc(p.toUtc), p.party ?? null, p.note ?? null, enteredBy],
      );
    } else {
      await pool.query(
        `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
         VALUES (?, ?, 'down', ?, ?, 'backfill', ?, ?)`,
        [companyId, p.resourceId, p.reason.code, sqlUtc(p.fromUtc), enteredBy, p.note ?? null],
      );
      await pool.query(
        `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
         VALUES (?, ?, 'idle', NULL, ?, 'backfill', ?, ?)`,
        [companyId, p.resourceId, sqlUtc(p.toUtc), enteredBy, `end of ${p.reason.code}`],
      );
    }
    applied++;
  }

  // What the day looks like now — the "new values shown" after upload.
  const after = [];
  for (const rid of new Set(parsed.map((p) => p.resourceId))) {
    const d = await dayGaps(companyId, rid, date);
    after.push({
      resourceId: rid, resourceName: d.resourceName,
      workingMinutes: d.workingMinutes, explainedMinutes: d.explainedMinutes,
      gapMinutes: d.gapMinutes,
    });
  }

  return { ok: true, applied, preview, errors: [], after };
}
