/**
 * boqSheetService.js — the order's BOQ as ONE sheet, the way the shop writes it.
 *
 * Their real Bill of Quantity is a single flat list. The hierarchy is not tabs
 * or pasted parent codes — it is columns:
 *
 *   Span | Girder | Segment | Part | Part Name | Raw Material | Thick | Length | Width | Qty | Flow
 *   S1   | G1     | 1       | TF1  | Top Flange| MSP-E350BO-40|  40   | 7500   | 500   |  1  | Part Fab — Plain
 *
 * which is exactly their existing "Shipping Mark G1 - 1 / Part List TF1", with
 * the mark split into the two levels it always meant. The codes ARE the
 * structure: a level is created the first time its code appears, so nothing has
 * to be copy-pasted between sheets and nothing has to be filled in twice.
 *
 * The resulting item code reads the same way — `<order prefix>-S1-G1-1-TF1`.
 *
 * A row with a blank Part declares the level above it, which is how an assembly
 * gets its own Operation Flow (a girder segment is welded; it is work in its own
 * right, not just a container).
 *
 * Blank intermediate levels collapse: a PEB with no girders or segments is just
 * Span + Part, and nothing about the format has to change to say so.
 *
 * WEIGHT IS NOT IN THIS SHEET. It is volume x density, taken from the material's
 * own `density_kg_m3` and, for anything that is not flat, its `section_area_mm2`
 * — see itemWeightService. Their BOQ has never typed a part weight and there is
 * no reason to start.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import { orderCodePrefix, composeCode, normaliseAbbr, materialSegment } from './itemCodeService.js';

const SHEET = 'BOQ';
const TEMPLATE_ROWS = 600;

/** Ordered, and the order is the hierarchy. */
export const LEVELS = [
  { key: 'span',    header: 'Span',    width: 10 },
  { key: 'girder',  header: 'Girder',  width: 10 },
  { key: 'segment', header: 'Segment', width: 10 },
  { key: 'part',    header: 'Part',    width: 12 },
];

const COLS = [
  ...LEVELS.map((l) => ({ header: l.header, width: l.width, key: l.key })),
  { header: 'Part Name',      width: 30, key: 'name' },
  { header: 'Raw Material',   width: 20, key: 'rmCode' },
  { header: 'Thick',          width: 9,  key: 'height' },
  { header: 'Length',         width: 10, key: 'length' },
  { header: 'Width',          width: 10, key: 'width' },
  { header: 'Qty',            width: 8,  key: 'qty' },
  { header: 'Operation Flow', width: 26, key: 'flowRef' },
  { header: 'Notes',          width: 26, key: 'notes' },
];
const C = Object.fromEntries(COLS.map((c, i) => [c.key, i + 1]));

// ── cell helpers ─────────────────────────────────────────────────────────────

function cellVal(row, col) {
  if (!col) return null;
  const c = row.getCell(col);
  const x = c.value;
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    if (Array.isArray(x.richText)) return x.richText.map((r) => r.text).join('').trim() || null;
    if (x.text !== undefined)   return String(x.text).trim() || null;
    if (x.result !== undefined) return String(x.result).trim() || null;
    return null;
  }
  return String(x).trim() || null;
}
function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const key = (s) => String(s ?? '').trim().toUpperCase();

function styledHeader(ws) {
  ws.addRow(COLS.map((c) => c.header));
  const r = ws.getRow(1);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  r.alignment = { vertical: 'middle', horizontal: 'center' };
  r.height = 20;
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  // The four level columns are the structure — tint them so it reads as one block.
  for (let i = 1; i <= LEVELS.length; i++) {
    ws.getColumn(i).font = { bold: true };
  }
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: LEVELS.length }];
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * @param {object[]} [seedRows] rows to pre-fill (the wizard's output). Each is
 *        `{ span, girder, segment, part, name, rmCode, height, length, width, qty, flowRef, notes }`.
 */
export async function exportBoqSheet(companyId, orderId, seedRows = null) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');
  const prefix = await orderCodePrefix(companyId, orderId);

  const [flows] = await pool.query(
    `SELECT f.name, f.code,
            GROUP_CONCAT(o.name ORDER BY fs.seq_no SEPARATOR ' -> ') AS operations
       FROM fab_operation_flows f
       LEFT JOIN fab_operation_flow_steps fs ON fs.flow_id=f.id AND fs.company_id=f.company_id AND fs.deleted_at IS NULL
       LEFT JOIN fab_operations o ON o.id=fs.operation_id AND o.company_id=f.company_id AND o.deleted_at IS NULL
      WHERE f.company_id=? AND f.active=1 AND f.deleted_at IS NULL
      GROUP BY f.id, f.name, f.code ORDER BY f.name`,
    [companyId],
  );

  const [materials] = await pool.query(
    `SELECT code, name, density_kg_m3, section_area_mm2 FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND procurement_type = 'buy'
      ORDER BY code`,
    [companyId],
  );

  const wb = new ExcelJS.Workbook();

  // ── Instructions ─────────────────────────────────────────────────────────
  const help = wb.addWorksheet('Instructions');
  help.getColumn(1).width = 108;
  [
    `Order ${orders[0].order_number} — BOQ`,
    '',
    'ONE SHEET. THE COLUMNS ARE THE STRUCTURE.',
    '  Span / Girder / Segment / Part hold CODES, and a level is created the first time its',
    '  code appears. Repeat the same Span and Girder down the rows — that is what says these',
    '  parts belong to it. Nothing is copy-pasted between sheets.',
    '',
    `  Every item's full code is built from them: ${prefix}-S1-G1-1-TF1`,
    '',
    'A ROW WITH A BLANK PART declares the level above it. That is how a girder or a segment',
    '  gets its own Operation Flow — welding a segment is work in its own right, not just a',
    '  heading. Put the assembly flow on that row.',
    '',
    'LEAVE A LEVEL BLANK IF THE JOB HAS NO SUCH THING. A PEB with no girders is just Span and',
    '  Part; the levels in between collapse and nothing else changes.',
    '',
    'WEIGHT IS NOT IN THIS SHEET. It is volume x density.',
    '     flat plate  thickness x width x length x density',
    '     profile     its cross-section x length x density',
    '  An angle, channel, beam or round bar is NOT thickness x width — an ISA 100x100x10 is an L',
    '  with two legs, so treating it as a 10 x 100 rectangle loses half the steel. Those carry',
    '  their own cross-section and need only a Length; the "Materials" sheet says which is which.',
    '  Fill in the dimensions and the Raw Material, and the weight follows.',
    '',
    'RAW MATERIAL is the Item Catalog code of the stock the part is cut from. It links the part',
    '  to inventory: when that material is received, the tasks waiting on it start by themselves.',
    '',
    'QTY is how many of this part go into ONE of its parent. Defaults to 1.',
    '',
    'OPERATION FLOW must match a flow on the "Flows" sheet. An unrecognised flow rejects the',
    '  row — an item with no flow produces no work at all, and a silent skip is worse than a',
    '  rejected line.',
  ].forEach((l) => help.addRow([l]));
  help.getRow(1).font = { bold: true, size: 13 };
  help.eachRow((row, n) => {
    if (n === 1) return;
    const t = String(row.getCell(1).value ?? '');
    if (t && t === t.toUpperCase() && /[A-Z]/.test(t) && !t.startsWith(' ')) row.font = { bold: true };
  });

  // ── BOQ ──────────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(SHEET);
  styledHeader(ws);

  const rows = seedRows ?? await readExistingAsRows(companyId, orderId);
  for (const r of rows) {
    ws.addRow([
      r.span ?? '', r.girder ?? '', r.segment ?? '', r.part ?? '',
      r.name ?? '', r.rmCode ?? '',
      r.height ?? '', r.length ?? '', r.width ?? '', r.qty ?? '',
      r.flowRef ?? '', r.notes ?? '',
    ]);
  }
  applyFlowDropdown(ws, flows.length, rows.length);

  // ── Flows ────────────────────────────────────────────────────────────────
  const wsF = wb.addWorksheet('Flows');
  wsF.addRow(['Flow Name', 'Flow Code', 'Operations']);
  wsF.getRow(1).font = { bold: true };
  [34, 18, 84].forEach((w, i) => { wsF.getColumn(i + 1).width = w; });
  for (const f of flows) wsF.addRow([f.name, f.code, f.operations || '(no steps defined)']);
  if (!flows.length) wsF.addRow(['(no active flows — set them up under Operations › Flows first)', '', '']);

  // ── Materials ────────────────────────────────────────────────────────────
  // Carries the weight factor, because "why is this part 12 kg" is answered here.
  const wsM = wb.addWorksheet('Materials');
  wsM.addRow(['Code', 'Name', 'Density (kg/m³)', 'Section area (mm²)', 'Dimensions needed', 'How the weight is worked out']);
  wsM.getRow(1).font = { bold: true };
  [22, 34, 16, 18, 24, 52].forEach((w, i) => { wsM.getColumn(i + 1).width = w; });
  for (const m of materials) {
    // DECIMAL comes back from mysql2 as a string; written raw it lands in the
    // sheet as text, which reads as a number but will not add up.
    const d = m.density_kg_m3 == null ? null : Number(m.density_kg_m3);
    const a = m.section_area_mm2 == null ? null : Number(m.section_area_mm2);
    wsM.addRow([
      m.code, m.name, d ?? '', a ?? '',
      d == null ? '—' : a != null ? 'Length only' : 'Thick + Width + Length',
      d == null ? 'no density set — weight cannot be worked out'
        : a != null ? `${a} mm² × length × ${d} kg/m³  (a profile is not thickness × width)`
          : `thickness × width × length × ${d} kg/m³`,
    ]);
  }

  return wb.xlsx.writeBuffer();
}

/** Read the order's current tree back into sheet rows, so it round-trips. */
async function readExistingAsRows(companyId, orderId) {
  const [items] = await pool.query(
    `SELECT fi.id, fi.parent_item_id, fi.name, fi.code, fi.level_kind, fi.qty, fi.unit,
            fi.length, fi.width, fi.height, fi.catalog_item_id, fi.flow_id,
            fic.code AS catalog_code, fof.name AS flow_name
       FROM fab_items fi
       LEFT JOIN fab_item_catalog fic ON fic.id = fi.catalog_item_id
       LEFT JOIN fab_operation_flows fof ON fof.id = fi.flow_id AND fof.deleted_at IS NULL
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
      ORDER BY fi.id`,
    [companyId, orderId],
  );
  if (!items.length) return [];

  const byId = new Map(items.map((i) => [i.id, i]));
  const hasChild = new Set(items.filter((i) => i.parent_item_id != null).map((i) => i.parent_item_id));
  const isRmLink = (i) => !hasChild.has(i.id) && i.catalog_item_id != null && !i.flow_name;

  /** The last segment of a code is the level's own label. */
  const labelOf = (i) => {
    if (!i.code) return i.name;
    const parent = i.parent_item_id != null ? byId.get(i.parent_item_id) : null;
    if (parent?.code && i.code.startsWith(`${parent.code}-`)) return i.code.slice(parent.code.length + 1);
    const bits = String(i.code).split('-');
    return bits[bits.length - 1];
  };

  const chainOf = (i) => {
    const out = [];
    let cur = i;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(cur);
      cur = cur.parent_item_id != null ? byId.get(cur.parent_item_id) : null;
    }
    return out;
  };

  // A part's raw material is its RM child; the child itself is not a row here.
  const rmOf = new Map();
  for (const i of items) {
    if (!isRmLink(i) || i.parent_item_id == null) continue;
    if (!rmOf.has(i.parent_item_id)) rmOf.set(i.parent_item_id, i.catalog_code);
  }

  const rows = [];
  for (const i of items) {
    if (isRmLink(i)) continue;
    const chain = chainOf(i).filter((c) => !isRmLink(c));
    const levels = ['', '', '', ''];
    chain.slice(0, LEVELS.length).forEach((c, idx) => { levels[idx] = labelOf(c); });

    // Only the deepest node of a branch carries part detail; an assembly row
    // exists to hold its own flow.
    const isLeafish = !hasChild.has(i.id) || (items.filter((c) => c.parent_item_id === i.id).every(isRmLink));
    rows.push({
      span: levels[0], girder: levels[1], segment: levels[2], part: levels[3],
      name: isLeafish ? i.name : '',
      rmCode: rmOf.get(i.id) ?? '',
      height: i.height != null ? Number(i.height) : '',
      length: i.length != null ? Number(i.length) : '',
      width:  i.width  != null ? Number(i.width)  : '',
      qty:    i.qty    != null ? Number(i.qty)    : '',
      flowRef: i.flow_name ?? '',
      notes: '',
    });
  }
  return rows;
}

function applyFlowDropdown(ws, flowCount, filledRows) {
  if (flowCount < 1) return;
  const src = `Flows!$A$2:$A$${flowCount + 1}`;
  for (let r = 2; r <= Math.max(TEMPLATE_ROWS, filledRows + 1); r++) {
    ws.getCell(r, C.flowRef).dataValidation = {
      type: 'list', allowBlank: true, formulae: [src], showErrorMessage: true,
      errorStyle: 'warning', errorTitle: 'Unknown flow',
      error: 'Pick a flow from the "Flows" sheet. An unrecognised flow rejects the row on upload.',
    };
  }
}

// ── import ───────────────────────────────────────────────────────────────────

function parseRows(ws) {
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const levels = LEVELS.map((l) => cellVal(row, C[l.key]));
    if (levels.every((v) => !v) && !cellVal(row, C.name)) return;
    out.push({
      row: n,
      levels,
      name:    cellVal(row, C.name),
      rmCode:  cellVal(row, C.rmCode),
      height:  numVal(row, C.height),
      length:  numVal(row, C.length),
      width:   numVal(row, C.width),
      qty:     numVal(row, C.qty),
      flowRef: cellVal(row, C.flowRef),
    });
  });
  return out;
}

/**
 * @param {'append'|'replace'} mode
 */
export async function importBoqSheet(file, companyId, orderId, mode = 'append') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet(SHEET)
    ?? wb.worksheets.find((s) => /^boq$/i.test(s.name.trim()));
  if (!ws) throw new Error(`No "${SHEET}" sheet found in the uploaded file. Download the template from this order and fill that in.`);

  const [orders] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  if (mode === 'replace') {
    const [[worked]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
      [companyId, orderId],
    );
    if (worked.cnt > 0) {
      throw new Error(
        `Replace refused: ${worked.cnt} task(s) on this order have already been started or finished. `
        + 'Replacing the item tree would throw that shop-floor history away. Import with Append instead.',
      );
    }
  }

  const parsed = parseRows(ws);
  const result = {
    mode, itemsCreated: 0, levelsCreated: 0, itemsSkipped: 0, itemsDeleted: 0,
    rmLinks: 0, totalWeight: null, unweighedLeaves: 0, warnings: [],
  };
  if (!parsed.length) {
    result.warnings.push({ message: 'The uploaded BOQ sheet had no filled-in rows.' });
    return result;
  }

  const conn = await pool.getConnection();
  const rowLog = [];
  const nodeByCode = new Map(); // full code -> { id }

  try {
    await conn.beginTransaction();
    const prefix = await orderCodePrefix(companyId, orderId, conn);

    if (mode === 'replace') {
      const [[before]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM fab_items WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
        [companyId, orderId],
      );
      await conn.query('UPDATE fab_project_tasks SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      await conn.query('UPDATE fab_task_inputs SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      await conn.query('UPDATE fab_items SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [companyId, orderId]);
      result.itemsDeleted = before.cnt;
    } else {
      const [existing] = await conn.query(
        `SELECT id, code FROM fab_items
          WHERE company_id = ? AND order_id = ? AND code IS NOT NULL AND deleted_at IS NULL`,
        [companyId, orderId],
      );
      for (const e of existing) nodeByCode.set(key(e.code), { id: e.id });
    }

    const [cats] = await conn.query(
      'SELECT id, code, name, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL',
      [companyId],
    );
    const catByCode = new Map(cats.map((c) => [key(c.code), c]));

    const [flows] = await conn.query(
      `SELECT id, name, code FROM fab_operation_flows
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL`,
      [companyId],
    );
    const flowBy = new Map();
    for (const f of flows) {
      flowBy.set(key(f.name), f.id);
      if (f.code) flowBy.set(key(f.code), f.id);
    }

    for (const r of parsed) {
      const path = r.levels.map((v, i) => ({ label: v, kind: LEVELS[i].key })).filter((p) => p.label);
      const base = { row: r.row, path: path.map((p) => p.label).join(' / '), name: r.name ?? '' };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.itemsSkipped++; };

      if (!path.length) { skip('No level code on this row — at least a Span is needed.'); continue; }

      let flowId = null;
      if (r.flowRef) {
        flowId = flowBy.get(key(r.flowRef)) ?? null;
        if (!flowId) {
          skip(`Operation Flow '${r.flowRef}' is not an active flow. Pick one from the "Flows" sheet — an item with no flow produces no tasks at all.`);
          continue;
        }
      }

      let material = null;
      if (r.rmCode) {
        material = catByCode.get(key(r.rmCode)) ?? null;
        if (!material) { skip(`Raw Material '${r.rmCode}' is not in the Item Catalog.`); continue; }
      }

      // Walk the path, creating any level that has not been seen yet. This is
      // what lets the same Span/Girder be repeated down hundreds of rows
      // without creating hundreds of girders.
      let parentId = null;
      let parentCode = prefix;
      let node = null;
      let createdHere = false;

      for (let i = 0; i < path.length; i++) {
        const seg = normaliseAbbr(path[i].label) ?? key(path[i].label);
        const code = composeCode(parentCode, seg);
        const isLast = i === path.length - 1;
        let hit = nodeByCode.get(key(code));

        if (!hit) {
          const [ins] = await conn.query(
            `INSERT INTO fab_items
               (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
                length, width, height, code, level_kind)
             VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
            [
              companyId, orderId, parentId,
              // An intermediate level has no name of its own in the BOQ — the
              // code is what everyone calls it.
              isLast ? (r.name ?? path[i].label) : path[i].label,
              'pcs',
              isLast ? (r.qty ?? 1) : 1,
              isLast ? flowId : null,
              isLast ? r.length : null,
              isLast ? r.width : null,
              isLast ? r.height : null,
              code, path[i].kind,
            ],
          );
          hit = { id: ins.insertId };
          nodeByCode.set(key(code), hit);
          if (isLast) { result.itemsCreated++; createdHere = true; } else result.levelsCreated++;
        } else if (isLast) {
          // The level already exists — this row is filling in its detail
          // (typically an assembly row carrying the flow).
          await conn.query(
            `UPDATE fab_items SET
               name = COALESCE(?, name), qty = COALESCE(?, qty), flow_id = COALESCE(?, flow_id),
               length = COALESCE(?, length), width = COALESCE(?, width), height = COALESCE(?, height)
             WHERE id = ? AND company_id = ?`,
            [r.name, r.qty, flowId, r.length, r.width, r.height, hit.id, companyId],
          );
          createdHere = true;
        }

        parentId = hit.id;
        parentCode = code;
        node = hit;
      }

      // Raw material hangs under the part — the same link the task gate reads.
      if (material && node) {
        const rmCode = composeCode(parentCode, materialSegment(material.code, material.name));
        if (!nodeByCode.has(key(rmCode))) {
          const [ins] = await conn.query(
            `INSERT INTO fab_items
               (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id, code, level_kind)
             VALUES (?,?,?,?,?,?,1,NULL,?, 'material')`,
            [companyId, orderId, node.id, material.id, material.name, material.unit || 'pcs', rmCode],
          );
          nodeByCode.set(key(rmCode), { id: ins.insertId });
          result.rmLinks++;
        }
      }

      rowLog.push({ ...base, status: createdHere ? 'Created' : 'Skipped',
        reason: createdHere ? '' : 'Nothing to create on this row.' });
      if (!createdHere) result.itemsSkipped++;
    }

    const w = await recomputeOrderWeights(companyId, orderId, conn);
    result.totalWeight = w.totalWeight;
    result.unweighedLeaves = w.unweighedLeaves;

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  result.reportBase64 = (await buildReport(rowLog)).toString('base64');
  return result;
}

/** The kinds of thing a sales-order line can be. */
export const LINE_TYPES = [
  'Composite Girder', 'BowString', 'Tub Girder', 'Openweb Girder', 'PEB',
];

/**
 * Turn "6 girders, 5 segments each, these parts in every segment" into the rows
 * of a starting sheet.
 *
 * This only ever produces a spreadsheet. It is scaffolding to save typing the
 * same Span/Girder/Segment codes four hundred times — the real structure is
 * whatever comes back on upload, so anything here can be edited, deleted or
 * added to first. That is also why nothing is written to the database: a
 * half-thought-through wizard run must not leave a half-built tree behind.
 *
 * A count of zero collapses that level, which is how a PEB (no girders, no
 * segments) uses the same wizard as a six-girder span.
 *
 * @param {object} spec
 * @param {string} [spec.spanCode]
 * @param {number} [spec.girders]
 * @param {number} [spec.segmentsPerGirder]
 * @param {{code:string,name?:string,rmCode?:string,qty?:number,flowRef?:string}[]} [spec.parts]
 * @param {string} [spec.assemblyFlow] flow put on each segment (or girder if there are no segments)
 */
export function buildWizardRows(spec = {}) {
  const spanCode = String(spec.spanCode ?? 'S1').trim() || 'S1';
  const girders = Math.max(0, Number(spec.girders) || 0);
  const segs    = Math.max(0, Number(spec.segmentsPerGirder) || 0);
  const parts   = Array.isArray(spec.parts) ? spec.parts.filter((p) => p && p.code) : [];
  const rows = [];

  const partRows = (girder, segment) => parts.map((p) => ({
    span: spanCode, girder, segment, part: p.code,
    name: p.name ?? '', rmCode: p.rmCode ?? '',
    height: '', length: '', width: '',
    qty: p.qty ?? 1,
    flowRef: p.flowRef ?? '',
    notes: '',
  }));

  // The span itself, so it exists even before anything hangs off it.
  rows.push({ span: spanCode, girder: '', segment: '', part: '', name: '', rmCode: '', height: '', length: '', width: '', qty: 1, flowRef: '', notes: 'span' });

  if (!girders) {
    // No girders: parts sit straight under the span. A PEB looks like this.
    rows.push(...partRows('', ''));
    return rows;
  }

  for (let g = 1; g <= girders; g++) {
    const girder = `G${g}`;
    if (!segs) {
      // Girders but no segments — the girder is the assembly.
      rows.push({ span: spanCode, girder, segment: '', part: '', name: '', rmCode: '', height: '', length: '', width: '', qty: 1, flowRef: spec.assemblyFlow ?? '', notes: 'assembly' });
      rows.push(...partRows(girder, ''));
      continue;
    }
    rows.push({ span: spanCode, girder, segment: '', part: '', name: '', rmCode: '', height: '', length: '', width: '', qty: 1, flowRef: '', notes: 'girder' });
    for (let s = 1; s <= segs; s++) {
      rows.push({ span: spanCode, girder, segment: String(s), part: '', name: '', rmCode: '', height: '', length: '', width: '', qty: 1, flowRef: spec.assemblyFlow ?? '', notes: 'assembly' });
      rows.push(...partRows(girder, String(s)));
    }
  }
  return rows;
}

async function buildReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  ws.addRow(['Row', 'Path', 'Part Name', 'Status', 'Reason']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  [7, 34, 28, 11, 62].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const r of rowLog) {
    ws.addRow([r.row, r.path, r.name, r.status, r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((c) => { c.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}
