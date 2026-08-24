/**
 * nestingSheetService.js — stage 2 of a sales order: which plate each part is
 * cut from.
 *
 * Its own document, downloaded and uploaded separately from the BOQ, because it
 * arrives at a different time from a different place — the BOQ comes off the
 * drawing, nesting comes off the nesting software once someone has actually laid
 * the parts out on stock. Keeping them in one file meant neither could be
 * finished without the other, and re-uploading one wiped the other.
 *
 *   Nest No | Raw Material  | Thick | Length | Width | Plates | Parts Cut From It
 *   N-001   | MSP-E350BO-20 |  20   | 12000  | 2500  |   1    | …-G1-1-TF1, …-G1-1-W1
 *
 * ONE ROW IS ONE PLATE. Ten or twenty parts off a single sheet is the normal
 * case, so they all go on that row.
 *
 * THE DIMENSIONS HERE ARE THE PLATE'S, not the parts'. That is the whole point:
 * a 20 mm plate at 12000 x 2500 weighs 4.7 t whatever is cut out of it, so the
 * material requirement is the plate, and the offcut is the difference between it
 * and the parts. The part's own size lives on the BOQ row.
 *
 * The plate's weight is never typed — it is volume x density from the chosen
 * material, the same calculation the parts use (see itemWeightService). Pick a
 * material and give the plate's size and everything else follows.
 *
 * Each (plate, part) pair becomes a raw-material child under that part, which is
 * the shape taskGatingService already reads as "material to consume", and which
 * `wipInventoryService.claimNest` draws from stock exactly once per nest.
 */

import fs from 'fs';
import ExcelJS from 'exceljs';
import { pool } from '../../../db.js';
import { recomputeOrderWeights, computeUnitWeight } from './itemWeightService.js';
import { composeCode, materialSegment } from './itemCodeService.js';
import { propagateLineIds } from './boqSheetService.js';
import { rawMaterialsFor } from './rawMaterialService.js';
import { syncOrderProcurement } from './procurementService.js';

const SHEET = 'Nesting';
const TEMPLATE_ROWS = 400;

const COLS = [
  { header: 'Nest No',            width: 12, key: 'nestNo' },
  { header: 'Raw Material *',     width: 22, key: 'rmCode' },
  { header: 'Thick',              width: 9,  key: 'height' },
  { header: 'Length',             width: 11, key: 'length' },
  { header: 'Width',              width: 11, key: 'width' },
  { header: 'Plates',             width: 9,  key: 'plates' },
  { header: 'Parts Cut From It *', width: 70, key: 'partCodes' },
  { header: 'Notes',              width: 26, key: 'notes' },
];
const C = Object.fromEntries(COLS.map((c, i) => [c.key, i + 1]));

// ── cell helpers ─────────────────────────────────────────────────────────────

function cellVal(row, col) {
  if (!col) return null;
  const x = row.getCell(col).value;
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
const splitCodes = (raw) => String(raw ?? '').split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean);

function styledHeader(ws, cols) {
  ws.addRow(cols.map((c) => c.header));
  const r = ws.getRow(1);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  r.alignment = { vertical: 'middle', horizontal: 'center' };
  r.height = 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 20; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// ── export ───────────────────────────────────────────────────────────────────

export async function exportNestingSheet(companyId, orderId) {
  const [orders] = await pool.query(
    'SELECT id, order_number FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  const materials = await rawMaterialsFor(companyId);

  // Everything already nested on this order, read back grouped by plate.
  const [links] = await pool.query(
    `SELECT rm.nest_no, rm.qty, rm.length, rm.width, rm.height,
            fic.thickness_mm AS rm_thickness,
            fic.code AS rm_code, parent.code AS part_code
       FROM fab_items rm
       JOIN fab_items parent ON parent.id = rm.parent_item_id AND parent.deleted_at IS NULL
       JOIN fab_item_catalog fic ON fic.id = rm.catalog_item_id
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
        AND (rm.level_kind = 'material' OR (rm.level_kind IS NULL AND rm.catalog_item_id IS NOT NULL AND rm.flow_id IS NULL))
      ORDER BY fic.code, rm.nest_no, parent.code`,
    [companyId, orderId],
  );

  const byNest = new Map();
  for (const l of links) {
    if (!l.part_code) continue;
    const k = `${l.rm_code}|${l.nest_no ?? `~solo-${l.part_code}`}`;
    if (!byNest.has(k)) {
      byNest.set(k, {
        nestNo: l.nest_no ?? '', rmCode: l.rm_code,
        // Thickness defaults to the catalog item's own — a "20mm plate" row is
        // its thickness, so exporting a blank Thick column asked the user to
        // retype something the catalog already knew (and to get it right).
        height: l.height ?? l.rm_thickness,
        length: l.length, width: l.width,
        plates: l.qty, parts: [],
      });
    }
    byNest.get(k).parts.push(l.part_code);
  }

  // The parts on this order that could be nested but are not yet — a nesting
  // sheet that only lists what is done is no use for finishing the job.
  const [unnested] = await pool.query(
    `SELECT p.code, p.name FROM fab_items p
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND p.level_kind = 'part' AND p.code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fab_items c
                         WHERE c.parent_item_id = p.id AND c.deleted_at IS NULL
                           AND (c.level_kind = 'material' OR (c.level_kind IS NULL AND c.catalog_item_id IS NOT NULL AND c.flow_id IS NULL)))
      ORDER BY p.code`,
    [companyId, orderId],
  );

  const wb = new ExcelJS.Workbook();

  // ── Instructions ─────────────────────────────────────────────────────────
  const help = wb.addWorksheet('Instructions');
  help.getColumn(1).width = 108;
  [
    `Order ${orders[0].order_number} — Nesting`,
    '',
    'ONE ROW IS ONE PLATE.',
    '  Ten or twenty parts off a single sheet is normal — put all their codes in "Parts Cut',
    '  From It", separated by commas. Two plates of the same stock are two rows, N-001 and',
    '  N-002, not one row with everything on it.',
    '',
    'THE DIMENSIONS ARE THE PLATE\'S, NOT THE PARTS\'.',
    '  A 20 mm plate at 12000 x 2500 weighs the same whatever you cut out of it. That is the',
    '  material this order actually consumes; the difference between it and the parts is offcut.',
    '  Each part\'s own size is on the BOQ, not here.',
    '',
    'RAW MATERIAL is a code from the "Materials" sheet. It carries the density, so the plate\'s',
    '  weight is worked out for you — never type a weight. For an angle, channel or beam the',
    '  cross-section is already known and only a Length is needed.',
    '',
    'PLATES is how many identical plates this nest uses. Usually 1.',
    '',
    'NEST NO names the plate. Only has to be unique within a material; leave it blank and one',
    '  is numbered for you. It is what makes the plate get drawn from stock ONCE rather than',
    '  once per part cut from it.',
    '',
    'WHAT THIS UNLOCKS. A part with no material cannot be weighed and cannot wait on stock.',
    '  Once nested, the moment that material is received every task waiting on it starts by',
    '  itself — nothing here needs to be clicked.',
    '',
    'The "Parts to nest" sheet lists the parts on this order that have no material yet.',
  ].forEach((l) => help.addRow([l]));
  help.getRow(1).font = { bold: true, size: 13 };
  help.eachRow((row, n) => {
    if (n === 1) return;
    const t = String(row.getCell(1).value ?? '');
    if (t && t === t.toUpperCase() && /[A-Z]/.test(t) && !t.startsWith(' ')) row.font = { bold: true };
  });

  // ── Nesting ──────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(SHEET);
  styledHeader(ws, COLS);
  const nests = [...byNest.values()];
  for (const n of nests) {
    ws.addRow([
      n.nestNo, n.rmCode,
      n.height != null ? Number(n.height) : '',
      n.length != null ? Number(n.length) : '',
      n.width  != null ? Number(n.width)  : '',
      n.plates != null ? Number(n.plates) : 1,
      n.parts.join(', '), '',
    ]);
  }
  if (materials.length) {
    const src = `Materials!$A$2:$A$${materials.length + 1}`;
    for (let r = 2; r <= Math.max(TEMPLATE_ROWS, nests.length + 1); r++) {
      ws.getCell(r, C.rmCode).dataValidation = {
        type: 'list', allowBlank: true, formulae: [src], showErrorMessage: true,
        errorStyle: 'warning', errorTitle: 'Unknown material',
        error: 'Pick a code from the "Materials" sheet — an unrecognised one rejects the row.',
      };
    }
  }

  // ── Parts to nest ────────────────────────────────────────────────────────
  const wsP = wb.addWorksheet('Parts to nest');
  styledHeader(wsP, [{ header: 'Part Code', width: 46 }, { header: 'Part Name', width: 34 }]);
  for (const p of unnested) wsP.addRow([p.code, p.name]);
  if (!unnested.length) wsP.addRow(['(every part on this order is already nested)', '']);

  // ── Materials ────────────────────────────────────────────────────────────
  const wsM = wb.addWorksheet('Materials');
  styledHeader(wsM, [
    { header: 'Code', width: 22 }, { header: 'Name', width: 34 },
    { header: 'Density (kg/m³)', width: 16 }, { header: 'Section area (mm²)', width: 18 },
    { header: 'Dimensions needed', width: 24 },
  ]);
  for (const m of materials) {
    // DECIMAL arrives from mysql2 as a string; unconverted it lands as text.
    const d = m.density_kg_m3 == null ? null : Number(m.density_kg_m3);
    const a = m.section_area_mm2 == null ? null : Number(m.section_area_mm2);
    wsM.addRow([m.code, m.name, d ?? '', a ?? '',
      d == null ? 'no density set — cannot be weighed'
        : a != null ? 'Length only (profile)' : 'Thick + Length + Width']);
  }

  return wb.xlsx.writeBuffer();
}

// ── import ───────────────────────────────────────────────────────────────────

/**
 * @param {'append'|'replace'} mode  replace clears this order's existing
 *        raw-material links first; the BOQ tree itself is never touched.
 */
export async function importNestingSheet(file, companyId, orderId, mode = 'append') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  fs.unlinkSync(file.path);

  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets.find((s) => /^nesting$/i.test(s.name.trim()));
  if (!ws) throw new Error(`No "${SHEET}" sheet found. Download the nesting sheet from this order and fill that in.`);

  const [orders] = await pool.query(
    'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [orderId, companyId],
  );
  if (!orders.length) throw new Error('Order not found');

  const parsed = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rmCode = cellVal(row, C.rmCode);
    const parts = cellVal(row, C.partCodes);
    if (!rmCode && !parts) return;
    parsed.push({
      row: n,
      nestNo: cellVal(row, C.nestNo),
      rmCode: rmCode ?? '',
      height: numVal(row, C.height),
      length: numVal(row, C.length),
      width:  numVal(row, C.width),
      plates: numVal(row, C.plates),
      partCodes: splitCodes(parts),
    });
  });

  const result = {
    mode, nests: 0, links: 0, skipped: 0, deleted: 0,
    totalWeight: null, warnings: [],
  };
  if (!parsed.length) {
    result.warnings.push({ message: 'The Nesting sheet had no filled-in rows.' });
    return result;
  }

  const conn = await pool.getConnection();
  const rowLog = [];

  try {
    await conn.beginTransaction();

    if (mode === 'replace') {
      // Only the material links go — the BOQ tree is a different document's
      // work and must survive a re-nest.
      const [[before]] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM fab_items
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
            AND (level_kind = 'material' OR (level_kind IS NULL AND catalog_item_id IS NOT NULL AND flow_id IS NULL))`,
        [companyId, orderId],
      );
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW()
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
            AND (level_kind = 'material' OR (level_kind IS NULL AND catalog_item_id IS NOT NULL AND flow_id IS NULL))`,
        [companyId, orderId],
      );
      await conn.query(
        'UPDATE fab_nest_issues SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL',
        [companyId, orderId],
      );
      result.deleted = before.cnt;
    }

    const [cats] = await conn.query(
      `SELECT id, code, name, unit, density_kg_m3, section_area_mm2
         FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const catByCode = new Map(cats.map((c) => [key(c.code), c]));

    const [parts] = await conn.query(
      `SELECT id, code FROM fab_items
        WHERE company_id = ? AND order_id = ? AND code IS NOT NULL AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    const partByCode = new Map(parts.map((p) => [key(p.code), p.id]));

    const [existingLinks] = await conn.query(
      `SELECT code FROM fab_items
        WHERE company_id = ? AND order_id = ? AND code IS NOT NULL AND deleted_at IS NULL
          AND (level_kind = 'material' OR (level_kind IS NULL AND catalog_item_id IS NOT NULL AND flow_id IS NULL))`,
      [companyId, orderId],
    );
    const usedCodes = new Set(existingLinks.map((e) => key(e.code)));

    const nestSeq = new Map();
    const seenNests = new Set();

    for (const r of parsed) {
      const base = { row: r.row, nest: r.nestNo ?? '', rm: r.rmCode };
      const skip = (reason) => { rowLog.push({ ...base, status: 'Skipped', reason }); result.skipped++; };

      if (!r.rmCode) { skip('Raw Material is required — it says what this plate is.'); continue; }
      const material = catByCode.get(key(r.rmCode));
      if (!material) { skip(`Raw Material '${r.rmCode}' is not in the Item Catalog.`); continue; }
      if (!r.partCodes.length) { skip('List at least one part code under "Parts Cut From It".'); continue; }

      const mk = key(material.code);
      if (!nestSeq.has(mk)) nestSeq.set(mk, 0);
      let nestNo = String(r.nestNo ?? '').trim();
      if (!nestNo) {
        nestSeq.set(mk, nestSeq.get(mk) + 1);
        nestNo = `N-${String(nestSeq.get(mk)).padStart(3, '0')}`;
      }

      // The plate's own weight, from its own dimensions — never typed.
      const plateWeight = computeUnitWeight(
        { length: r.length, width: r.width, height: r.height }, material,
      );
      if (plateWeight === null) {
        result.warnings.push({
          message: `Nest ${nestNo} (${material.code}) has no weight — `
            + (material.density_kg_m3 == null
              ? 'that material has no density set in the Item Catalog.'
              : 'fill in the plate\'s dimensions.'),
        });
      }

      const seg = materialSegment(material.code, material.name);
      let made = 0;

      for (const partCode of r.partCodes) {
        const partId = partByCode.get(key(partCode));
        if (!partId) {
          rowLog.push({ ...base, status: 'Skipped', reason: `Part '${partCode}' is not on this order.` });
          result.skipped++;
          continue;
        }
        const code = composeCode(partCode.trim(), seg);
        if (usedCodes.has(key(code))) {
          rowLog.push({ ...base, status: 'Skipped', reason: `'${material.code}' is already nested onto '${partCode}'.` });
          result.skipped++;
          continue;
        }
        await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty, flow_id,
              length, width, height, code, nest_no, level_kind)
           VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?, 'material')`,
          [
            companyId, orderId, partId, material.id, material.name,
            material.unit || 'pcs', r.plates ?? 1,
            r.length, r.width, r.height, code, nestNo,
          ],
        );
        usedCodes.add(key(code));
        result.links++;
        made++;
      }

      if (made > 0) {
        seenNests.add(`${mk}|${nestNo}`);
        rowLog.push({ ...base, status: 'Created', reason: `${made} part(s) nested on ${nestNo}` });
      }
    }

    result.nests = seenNests.size;
    // The material links just hung under their parts inherit those parts' line.
    await propagateLineIds(conn, companyId, orderId);
    // Those links are catalog stock draws, so this is what makes them 'buy'.
    await syncOrderProcurement(conn, companyId, orderId);
    const w = await recomputeOrderWeights(companyId, orderId, conn);
    result.totalWeight = w.totalWeight;

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

async function buildReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Nesting Log');
  styledHeader(ws, [
    { header: 'Row', width: 7 }, { header: 'Nest', width: 12 },
    { header: 'Raw Material', width: 22 }, { header: 'Status', width: 11 },
    { header: 'Reason', width: 62 },
  ]);
  for (const r of rowLog) {
    ws.addRow([r.row, r.nest, r.rm, r.status, r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((c) => { c.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}
