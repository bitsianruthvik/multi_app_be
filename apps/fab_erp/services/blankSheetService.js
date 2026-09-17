/**
 * blankSheetService.js — the cutting plan as a spreadsheet, and back.
 *
 * ── WHY THE SUGGESTION MUST NOT BE THE ONLY WAY IN ───────────────────────────
 *
 * The packer is good and it is not the person who knows this yard. It does not
 * know that the 40 mm is stacked behind the 25 mm, that a particular sheet is
 * spoken for, or that the cutter would rather do all the diaphragm plates in one
 * setup. A planner who cannot express any of that ends up keeping the real plan
 * in a spreadsheet beside the software, and then the software is describing a
 * job nobody is doing.
 *
 * So the plan goes out as a sheet, gets edited, and comes back — the same
 * suggest-or-do-it-yourself pairing the old nesting board had, which is the part
 * of it worth keeping.
 *
 * ── THE SHEET: "How it gets cut" ─────────────────────────────────────────────
 *
 *   Blank | Blank (T x W x L) | Material | Grade | Needed ‖ Nest | Plate code | Qty on this sheet
 *
 * Built for somebody who nested ELSEWHERE and only has to say "N-001 is on
 * plate X, and these blanks, this many". Every blank the order needs is
 * already a row, with what it is and how many; the three cells on the right
 * are the only ones to fill. Qty on this sheet starts at Needed.
 *
 * ONE ROW PER (SHEET, BLANK). Rows sharing a Nest name are cut from ONE plate.
 * Copy a row to split a blank across sheets. Get that grouping wrong on the way
 * back in and the shop draws one physical sheet per rectangle on it.
 *
 * THE PLATE IS A DROPDOWN, restricted per row to plates whose thickness,
 * material and grade match that blank (a hidden "Plates" sheet holds one
 * column per combination; each row's validation points at its column). So a
 * 25 mm blank cannot be picked onto 16 mm plate from the list. The server
 * still verifies on upload — a dropdown is a courtesy, not a gate.
 *
 * MATCHED BY CODE on the way back, or by a size typed as "25x2000x12000"
 * (the blank's material and grade implied) when that names exactly one plate.
 * A Nest left empty on a row that names a plate gets its own new number.
 *
 * NOTHING IS WRITTEN UNTIL THE WHOLE SHEET PARSES. A plan half-imported because
 * row 180 named a plate that does not exist is worse than one not imported at
 * all: the order looks planned, and the missing sheets are found by someone
 * counting.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { blankPlan } from './blankPlanService.js';
import { orderBlanks } from './blankService.js';
import { plateCatalog } from './plateSourceService.js';
import { plateFits } from './materialMatchService.js';

const SHEET = 'How it gets cut';
/** The sheet the older exports carried — still read on upload. */
const OLD_SHEET = 'Cutting plan';
const PLATES_SHEET = 'Plates';           // hidden: dropdown sources
const ON_HAND_SHEET = 'Plates on hand';  // visible: the same plates, for reading

/*
 * WHAT THE BLANK IS comes first, WHAT TO FILL comes after the divider.
 * "Blank" is the SHORT handle — the code after the order's own prefix
 * (MS-E350BO-16X1800X10000); the full code sits at the far right for the
 * record and is accepted on the way back in too. Columns are found by header
 * on import, so the older layout (Nest first, full code in column D) still
 * reads.
 */
const HEADERS = [
  'Blank', 'Blank (T x W x L)', 'Material', 'Grade', 'Needed',
  'Nest', 'Plate code', 'Qty on this sheet', 'Blank full code',
];
const COL = { blank: 1, size: 2, material: 3, grade: 4, needed: 5, nest: 6, plate: 7, qty: 8, full: 9 };

const FILL_GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const FILL_INPUT = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };

const comboKey = (b) => [b.thickness, b.material ?? '', b.grade ?? ''].join('|');
const sizeText = (t, w, l) => `${t} x ${w} x ${l}`;

/**
 * Every buyable plate with the number on hand (FULL plates — a drop is a
 * different size and is offered by the packer, not by a dropdown).
 */
async function platesWithStock(companyId) {
  const plates = await plateCatalog(companyId);
  if (!plates.length) return [];
  const [rows] = await pool.query(
    `SELECT catalog_item_id AS id, COALESCE(SUM(qty), 0) AS onHand
       FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'in_stock'
        AND origin_piece_id IS NULL AND catalog_item_id IN (?)
      GROUP BY catalog_item_id`,
    [companyId, plates.map((p) => p.id)],
  );
  const onHand = new Map(rows.map((r) => [Number(r.id), Number(r.onHand) || 0]));
  return plates
    .map((p) => ({ ...p, onHand: onHand.get(Number(p.id)) ?? 0 }))
    .sort((a, b) => a.thickness - b.thickness
      || String(a.material ?? '').localeCompare(String(b.material ?? ''))
      || String(a.grade ?? '').localeCompare(String(b.grade ?? ''))
      || a.width * a.length - b.width * b.length
      || String(a.code).localeCompare(String(b.code)));
}

/** What one dropdown entry reads — the code first, so the import can take it back off. */
const plateEntry = (p) => `${p.code} · ${sizeText(p.thickness, p.width, p.length)} · ${p.onHand} on hand`;

export async function exportPlan(companyId, orderId, opts = {}) {
  /*
   * `effort: 'template'` — THE BLANK LIST WITH NO SHEETS, for a planner who
   * nests by hand from the start (never runs the packer): every blank the
   * order needs, one row each, Nest and Plate code left empty to fill in.
   * Rides on the existing `effort` query so the download route is untouched;
   * anything else packs (or reads the saved plan) as before, and the same
   * layout comes out with Nest / Plate code / Qty pre-filled.
   */
  const plan = opts.effort === 'template'
    ? await (async () => {
      const { orderNumber, blanks } = await orderBlanks(companyId, orderId);
      return { orderNumber, blanks, nests: [] };
    })()
    : await blankPlan(companyId, orderId, opts);

  const plates = await platesWithStock(companyId);
  const platesByCombo = new Map();
  for (const p of plates) {
    const k = comboKey(p);
    if (!platesByCombo.has(k)) platesByCombo.set(k, []);
    platesByCombo.get(k).push(p);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET);

  ws.addRow([`How it gets cut — ${plan.orderNumber}`]);
  ws.addRow(['1. Fill Nest and Plate code on each row. Plate code is a dropdown of plates that match the blank; a size like 25x2000x12000 also works.']);
  ws.addRow(['2. Copy a row to split a blank across sheets; set Qty on this sheet on each copy.']);
  ws.addRow(['3. Rows with the same Nest are ONE plate. Leave Nest empty and the upload numbers that row\'s sheet for you.']);
  ws.addRow([]);
  ws.getRow(1).font = { bold: true, size: 13 };
  for (const n of [2, 3, 4]) ws.getRow(n).font = { size: 10, italic: true };

  const head = ws.addRow(HEADERS);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = FILL_GREY; });
  const headerRowNo = head.number;
  ws.views = [{ state: 'frozen', ySplit: headerRowNo }];

  /*
   * ROWS GROUPED BY BLANK: each blank's sheets (from the plan) in order, then
   * one more row for whatever is not yet on a sheet — which for a template is
   * the whole demand, and for an accepted plan is usually nothing.
   */
  const rowsByBlank = new Map(plan.blanks.map((b) => [b.key, []]));
  for (const n of plan.nests) {
    for (const it of n.items) {
      const list = rowsByBlank.get(it.key);
      if (list) list.push({ nestNo: n.nestNo ?? '', plateCode: n.plateCode ?? '', qty: it.qty });
    }
  }

  // The hidden Plates sheet: one column per combination, header = the combination.
  const ps = wb.addWorksheet(PLATES_SHEET);
  ps.state = 'hidden';
  const rangeByCombo = new Map();
  {
    let c = 0;
    for (const [k, list] of platesByCombo) {
      c += 1;
      const [t, m, g] = k.split('|');
      ps.getCell(1, c).value = `${t} mm ${[m, g].filter(Boolean).join(' ')}`.trim();
      ps.getCell(1, c).font = { bold: true };
      list.forEach((p, i) => { ps.getCell(i + 2, c).value = plateEntry(p); });
      const letter = ps.getColumn(c).letter;
      rangeByCombo.set(k, `'${PLATES_SHEET}'!$${letter}$2:$${letter}$${list.length + 1}`);
      ps.getColumn(c).width = 40;
    }
  }

  for (const b of plan.blanks) {
    const placed = rowsByBlank.get(b.key) ?? [];
    const covered = placed.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const lines = [...placed];
    if (b.qty - covered > 1e-6) lines.push({ nestNo: '', plateCode: '', qty: b.qty - covered });
    const range = rangeByCombo.get(comboKey(b));
    for (const ln of lines) {
      const row = ws.addRow([
        b.ref ?? '', sizeText(b.thickness, b.width, b.length),
        b.material ?? '', b.grade ?? '', b.qty,
        ln.nestNo, ln.plateCode, ln.qty, b.code,
      ]);
      for (const c of [COL.nest, COL.plate, COL.qty]) row.getCell(c).fill = FILL_INPUT;
      if (range) {
        /*
         * The dropdown. `warning` rather than `stop`: the list is what fits
         * this blank, and a size typed by hand ("25x2000x12000") is still
         * allowed after a prompt — the upload resolves and re-checks it.
         */
        row.getCell(COL.plate).dataValidation = {
          type: 'list', allowBlank: true, formulae: [range],
          showErrorMessage: true, errorStyle: 'warning',
          errorTitle: 'Not a matching plate',
          error: `Only ${b.thickness} mm ${[b.material, b.grade].filter(Boolean).join(' ')} plates are listed for this blank. `
            + 'Continue only if you typed a plate size on purpose.',
        };
      }
      row.getCell(COL.qty).dataValidation = {
        type: 'decimal', operator: 'greaterThan', formulae: [0], allowBlank: false,
        showErrorMessage: true, errorTitle: 'Quantity', error: 'Qty on this sheet must be a positive number.',
      };
    }
  }

  ws.getColumn(COL.blank).width = 28;
  ws.getColumn(COL.size).width = 20;
  ws.getColumn(COL.material).width = 10;
  ws.getColumn(COL.grade).width = 10;
  ws.getColumn(COL.needed).width = 9;
  ws.getColumn(COL.nest).width = 10;
  ws.getColumn(COL.plate).width = 40;
  ws.getColumn(COL.qty).width = 16;
  ws.getColumn(COL.full).width = 42;

  /*
   * A second sheet listing what has to be cut, so somebody planning by hand can
   * see the demand without going back to the screen — and so the file is a
   * complete statement of the job rather than half of one.
   */
  const ds = wb.addWorksheet('Blanks needed');
  ds.addRow(['Blank', 'Blank (T x W x L)', 'Material', 'Grade', 'Needed', 'Weight each (kg)', 'Serves parts', 'Blank full code'])
    .font = { bold: true };
  for (const b of plan.blanks) {
    ds.addRow([
      b.ref ?? '', sizeText(b.thickness, b.width, b.length),
      b.material ?? '', b.grade ?? '', b.qty,
      Number(b.unitWeightKg.toFixed(2)), b.partCount, b.code,
    ]);
  }
  ds.getColumn(1).width = 28;
  ds.getColumn(2).width = 24;
  for (const c of [3, 4, 5, 6, 7]) ds.getColumn(c).width = 15;
  ds.getColumn(8).width = 42;

  // The plates, readable: what each code is and how many full sheets are on the floor.
  const hs = wb.addWorksheet(ON_HAND_SHEET);
  hs.addRow(['Plate code', 'Name', 'Thickness', 'Width', 'Length', 'Material', 'Grade', 'On hand (full plates)'])
    .font = { bold: true };
  for (const p of plates) {
    hs.addRow([p.code, p.name ?? '', p.thickness, p.width, p.length, p.material ?? '', p.grade ?? '', p.onHand]);
  }
  hs.getColumn(1).width = 14;
  hs.getColumn(2).width = 40;
  for (const c of [3, 4, 5, 6, 7]) hs.getColumn(c).width = 11;
  hs.getColumn(8).width = 20;
  hs.views = [{ state: 'frozen', ySplit: 1 }];

  return {
    buffer: await wb.xlsx.writeBuffer(),
    filename: `Cutting_plan_${plan.orderNumber}.xlsx`,
  };
}

/**
 * Read a filled sheet back into the shape `acceptNestingPlan` takes.
 *
 * @returns {Promise<{plan:{nests:object[]}, rows:number, sheets:number, problems:string[]}>}
 */
export async function importPlan(companyId, orderId, buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.getWorksheet(OLD_SHEET) ?? wb.worksheets[0];
  if (!ws) { const e = new Error('That file has no sheets.'); e.status = 400; throw e; }

  // The header row is found rather than assumed: people add notes above it,
  // and "Nest" is no longer the first column.
  const headerText = (cell) => String(cell.value ?? '').trim().toLowerCase();
  let headerRow = 0;
  ws.eachRow((row) => {
    if (headerRow) return;
    let nest = false; let plate = false;
    row.eachCell((cell) => {
      const h = headerText(cell);
      if (h === 'nest') nest = true;
      if (h === 'plate code') plate = true;
    });
    if (nest && plate) headerRow = row.number;
  });
  if (!headerRow) {
    const e = new Error('No header row found — a row must carry "Nest" and "Plate code" headings.');
    e.status = 400; throw e;
  }
  /*
   * COLUMNS BY HEADER, not by position: the layout has changed twice already
   * (the short "Blank" handle moved next to the plate, then the whole blank
   * description moved ahead of the cells to fill) and a sheet somebody
   * downloaded last week must still read.
   */
  const col = {};
  ws.getRow(headerRow).eachCell((cell, c) => {
    const h = headerText(cell);
    if (h === 'nest') col.nest = c;
    else if (h === 'plate code') col.plate = c;
    else if (h === 'blank' || h === 'blank code') col.blank = col.blank ?? c;
    else if (h === 'blank full code') col.blankFull = c;
    else if (h.startsWith('qty')) col.qty = c;
  });
  const missing = ['nest', 'plate', 'blank', 'qty'].filter((k) => !col[k]);
  if (missing.length) {
    const e = new Error('The header must have Nest, Plate code, Blank and Qty columns.');
    e.status = 400; throw e;
  }
  const rows = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const cellText = (c) => (c ? String(row.getCell(c).value ?? '').trim() : '');
    rows.push({
      n,
      nestNo: cellText(col.nest),
      plateCode: cellText(col.plate),
      // The short handle, or the full code where the handle is blank.
      blankCode: cellText(col.blank) || cellText(col.blankFull),
      qtyRaw: row.getCell(col.qty).value,
    });
  });
  return importPlanRows(companyId, orderId, rows);
}

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*[x×X*]\s*(\d+(?:\.\d+)?)\s*[x×X*]\s*(\d+(?:\.\d+)?)$/;
const NEST_NO_RE = /^N-(\d+)$/i;
const rowList = (ns) => (ns.length === 1 ? `Row ${ns[0]}` : `Rows ${ns.join(', ')}`);

/**
 * Validate and group parsed rows into nests — the one reader of a plan,
 * whatever it was parsed from.
 *
 * A row is (nest, plate, blank, qty). What may be left out:
 *   - Nest, when the row names a plate: that row becomes its own new sheet,
 *     numbered after the highest N-xxx on the sheet.
 *   - Plate code, when another row with the same Nest names it.
 *   - Both, on a row that only carries a blank: that blank is not planned by
 *     this upload and is reported in `short`, not refused — it is how the
 *     template arrives, and leaving a blank for later is a decision.
 * A plate may be its code, the dropdown entry ("RM00029 · 16 x 2000 x 12000 ·
 * 3 on hand"), or a size "25x2000x12000" that names exactly one plate of the
 * blank's material and grade.
 *
 * @param {{n:number, nestNo:string, plateCode:string, blankCode:string, qtyRaw:*, malformed?:string}[]} inputRows
 */
export async function importPlanRows(companyId, orderId, inputRows) {
  const [plateRows] = await pool.query(
    `SELECT ci.id, ci.code FROM fab_item_catalog ci
       JOIN fab_item_groups g ON g.id = ci.group_id AND g.name = 'Plates'
      WHERE ci.company_id = ? AND ci.deleted_at IS NULL AND ci.code IS NOT NULL`,
    [companyId],
  );
  const plateByCode = new Map(plateRows.map((r) => [String(r.code).trim().toUpperCase(), { id: Number(r.id), code: String(r.code) }]));
  // Sized plates, for a plate given as a size rather than a code.
  const sized = await plateCatalog(companyId);

  /*
   * The blanks as this order currently computes them — the codes are derived,
   * so they exist whether or not anything has been written yet. `orderBlanks`
   * only walks the structure to name the rectangles; it does not run the
   * packer, which `blankPlan(..., {effort:'quick'})` used to do here just to
   * read the same codes off a full (if quick) pack (PLAN.md EU-11 item 7).
   */
  const plan = await orderBlanks(companyId, orderId);
  // Matched by the short handle (the code after the order prefix) OR the full
  // code — both are on the sheet.
  const blankByKey = new Map(plan.blanks.map((b) => [b.key, b]));
  const keyByCode = new Map([
    ...plan.blanks.map((b) => [String(b.code).trim().toUpperCase(), b.key]),
    ...plan.blanks.map((b) => [String(b.ref).trim().toUpperCase(), b.key]),
  ]);

  /** A plate reference on a row → {id, code} | {ambiguous: codes[]} | null. */
  const resolvePlate = (raw, blank) => {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const up = text.toUpperCase();
    if (plateByCode.has(up)) return plateByCode.get(up);
    // The dropdown entry, or "CODE anything": the code is the first token.
    const first = up.split('·')[0].trim().split(/\s+/)[0];
    if (first && plateByCode.has(first)) return plateByCode.get(first);
    const m = SIZE_RE.exec(text);
    if (!m) return null;
    const [t, a, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    const hits = sized.filter((p) => Math.min(p.width, p.length) === lo && Math.max(p.width, p.length) === hi
      && plateFits({ thickness: t, material: blank?.material ?? null, grade: blank?.grade ?? null }, p));
    if (hits.length === 1) return { id: Number(hits[0].id), code: String(hits[0].code) };
    if (hits.length > 1) return { ambiguous: hits.map((p) => p.code) };
    return null;
  };

  const problems = [];
  const parsed = [];       // rows that passed their own checks
  let maxNestNo = 0;
  let unplanned = 0;

  for (const r of inputRows) {
    const n = r.n;
    const nestNo = String(r.nestNo ?? '').trim();
    const plateRaw = String(r.plateCode ?? '').trim();
    const blankCode = String(r.blankCode ?? '').trim().toUpperCase();
    const qty = Number(r.qtyRaw);
    if (r.malformed) { problems.push(`Row ${n}: ${r.malformed}.`); continue; }
    if (!nestNo && !plateRaw && !blankCode) continue;   // a blank spacer row
    if (!nestNo && !plateRaw) { unplanned += 1; continue; } // a blank left for later

    const key = keyByCode.get(blankCode);
    if (!key) { problems.push(`Row ${n}: "${blankCode || '(blank)'}" is not a blank this order needs (use the Blank column as the sheet gives it).`); continue; }
    if (!Number.isFinite(qty) || qty <= 0) { problems.push(`Row ${n}: quantity "${r.qtyRaw}" is not a positive number.`); continue; }

    let plate = null;
    if (plateRaw) {
      plate = resolvePlate(plateRaw, blankByKey.get(key));
      if (!plate) { problems.push(`Row ${n}: "${plateRaw}" is not a plate code in the catalogue (nor a size that names one plate of this blank's material and grade).`); continue; }
      if (plate.ambiguous) { problems.push(`Row ${n}: "${plateRaw}" matches ${plate.ambiguous.join(', ')} — give the plate code.`); continue; }
    }
    const m = NEST_NO_RE.exec(nestNo);
    if (m) maxNestNo = Math.max(maxNestNo, Number(m[1]));
    parsed.push({ n, nestNo, plate, key, qty });
  }

  /*
   * AUTO-NUMBERING: a row with a plate and no Nest is its own sheet, named
   * after the highest N-xxx the sheet already uses — so a planner who only
   * types plates and never numbers gets N-001, N-002 … in row order, and one
   * who numbered some rows and not others does not get a collision.
   */
  const byNest = new Map();
  for (const p of parsed) {
    if (!p.nestNo) { maxNestNo += 1; p.nestNo = `N-${String(maxNestNo).padStart(3, '0')}`; }
    const hit = byNest.get(p.nestNo) ?? { nestNo: p.nestNo, rows: [] };
    hit.rows.push(p);
    byNest.set(p.nestNo, hit);
  }

  /*
   * ONE PLATE PER NEST. Two rows sharing a nest number but naming different
   * plates is not a thing the shop can do — it is one sheet — and guessing
   * which they meant would put the other rectangle on steel nobody chose. A
   * nest with no plate on any of its rows is likewise refused, naming them.
   */
  const nests = [];
  let rows = 0;
  for (const nest of byNest.values()) {
    const plates = new Map();
    for (const r of nest.rows) if (r.plate) plates.set(r.plate.id, r.plate);
    if (!plates.size) {
      problems.push(`${rowList(nest.rows.map((r) => r.n))}: nest ${nest.nestNo} names no plate code.`);
      continue;
    }
    if (plates.size > 1) {
      problems.push(`${rowList(nest.rows.map((r) => r.n))}: nest ${nest.nestNo} is given ${plates.size} plates `
        + `(${[...plates.values()].map((p) => p.code).join(', ')}); a nest is ONE sheet.`);
      continue;
    }
    const [plate] = plates.values();
    rows += nest.rows.length;
    nests.push({
      nestNo: nest.nestNo,
      plateCatalogItemId: plate.id,
      plateCode: plate.code,
      items: nest.rows.map((r) => ({ key: r.key, qty: r.qty })),
    });
  }

  if (!rows && !problems.length) {
    const e = new Error(unplanned
      ? 'That sheet has no row with a Nest or a Plate code filled in.'
      : 'That sheet has no rows under the header.');
    e.status = 400; throw e;
  }
  if (problems.length) {
    const e = new Error(`That plan could not be read:\n${problems.slice(0, 12).join('\n')}`
      + (problems.length > 12 ? `\n…and ${problems.length - 12} more` : ''));
    e.status = 400; e.problems = problems; throw e;
  }

  /*
   * WHAT THE SHEET DOES NOT COVER IS REPORTED, NOT FILLED IN. A hand-made plan
   * that leaves 200 stiffeners unaccounted for is a decision if it was meant and
   * a mistake if it was not, and only the person who wrote it knows which.
   */
  const planned = new Map();
  for (const n of nests) {
    for (const it of n.items) planned.set(it.key, (planned.get(it.key) ?? 0) + it.qty);
  }
  const short = plan.blanks
    .filter((b) => (planned.get(b.key) ?? 0) < b.qty)
    .map((b) => ({
      code: b.code,
      ref: b.ref ?? b.code,
      rect: `${b.thickness} x ${b.width} x ${b.length}`,
      needed: b.qty,
      planned: planned.get(b.key) ?? 0,
    }));

  return {
    plan: { nests },
    rows,
    sheets: nests.length,
    short,
    problems,
  };
}
