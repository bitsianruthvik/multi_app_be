/**
 * cncExportService.js — CF_ERP. The files the CNC nesting software reads.
 *
 *   lotDxf(db, companyId, lineId, lotId)  -> { filename, buffer }   one nest, DXF R12
 *   lineCncZip(db, companyId, lineId)     -> { filename, buffer }   every nest of a line
 *
 * The drawing is the SAVED plan: plate size off the lot row, pieces off
 * cf_nest_placements (true size, as placed), offcuts off cf_offcuts. Nothing is
 * re-solved here, so what is cut is what was agreed.
 *
 * A LOT WITHOUT A LAYOUT (an imported nest whose placements have null x/y —
 * the piece is on that plate but we found no layout) has no drawing: lotDxf
 * refuses it in words and the zip lists it in nests.csv as "no layout — use
 * the program it came from". A lot whose placements are only partly laid out
 * counts as having no layout too: a CNC file missing pieces is worse than none.
 *
 * OFFCUTS: read from cf_offcuts. When a lot has none stored (saved before that
 * table existed, or the table is not there yet) they are worked out from the
 * geometry with the company's offcut thresholds, so the drawing still shows
 * them. Three queries per call whatever the number of lots — TiDB is 49 ms a
 * round trip.
 *
 * Tenant: every read is scoped by company_id AND the order line; a lot that is
 * not on that line is "not found", never another tenant's drawing.
 */
import JSZip from 'jszip';
import { notFound, invalid } from '../lib/errors.js';
import { analyseNest, nestToDxf } from './nestGeometry.js';

const DEFAULT_MIN_AREA = 90000;
const DEFAULT_MIN_SIDE = 100;

const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const n3 = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 1000) / 1000);
const isMissingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;
const isMissingColumn = (e) => e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054;

async function requireLine(db, companyId, lineId) {
  const [[line]] = await db.query(
    `SELECT l.id, l.line_no, o.code AS order_code
       FROM cf_sales_order_lines l
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.company_id = l.company_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`,
    [companyId, lineId],
  );
  if (!line) throw notFound('Order line');
  return line;
}

const baseName = (line, lot) => `${safe(line.order_code)}-L${safe(line.line_no)}-${safe(lot.lot_no)}`;

/** Lots of a line (or one lot), their placements and offcuts: three round trips. */
async function loadLots(db, companyId, lineId, lotId = null) {
  const [lots] = await db.query(
    `SELECT l.*, m.code AS plate_code, m.name AS plate_name
       FROM cf_plate_lots l
       LEFT JOIN cf_master_records m ON m.id = l.plate_item_id AND m.company_id = l.company_id
      WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL
        ${lotId != null ? 'AND l.id = ?' : ''}
      ORDER BY l.lot_no, l.id`,
    lotId != null ? [companyId, lineId, lotId] : [companyId, lineId],
  );
  if (!lots.length) return { lots, pieces: new Map(), offcuts: new Map() };
  const ids = lots.map((l) => l.id);

  const [placeRows] = await db.query(
    `SELECT p.plate_lot_id, p.seq_no, p.row_no, p.pos_no, p.x_mm, p.y_mm, p.length_mm, p.width_mm, p.rotated,
            m.code AS cut_plate_code, m.name AS cut_plate_name
       FROM cf_nest_placements p
       LEFT JOIN cf_master_records m ON m.id = p.cut_plate_id AND m.company_id = p.company_id
      WHERE p.company_id = ? AND p.plate_lot_id IN (?) AND p.deleted_at IS NULL
      ORDER BY p.plate_lot_id, p.seq_no, p.row_no, p.pos_no`,
    [companyId, ids],
  );
  const pieces = new Map(ids.map((id) => [id, []]));
  for (const p of placeRows) {
    pieces.get(p.plate_lot_id)?.push({
      x: p.x_mm == null ? null : Number(p.x_mm),
      y: p.y_mm == null ? null : Number(p.y_mm),
      length: Number(p.length_mm),
      width: Number(p.width_mm),
      seqNo: p.seq_no,
      rowNo: p.row_no,
      code: p.cut_plate_code ?? p.cut_plate_name ?? '',
    });
  }

  const offcuts = new Map();
  try {
    const [rows] = await db.query(
      `SELECT plate_lot_id, offcut_no, area_mm2, weight_kg, bbox_length_mm, bbox_width_mm,
              rect_length_mm, rect_width_mm, outline_json, status
         FROM cf_offcuts
        WHERE company_id = ? AND order_line_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL
        ORDER BY plate_lot_id, offcut_no`,
      [companyId, lineId, ids],
    );
    for (const r of rows) {
      let outline = r.outline_json;
      if (typeof outline === 'string') { try { outline = JSON.parse(outline); } catch { outline = []; } }
      if (!offcuts.has(r.plate_lot_id)) offcuts.set(r.plate_lot_id, []);
      offcuts.get(r.plate_lot_id).push({
        offcutNo: r.offcut_no,
        area: n3(r.area_mm2),
        weightKg: n3(r.weight_kg),
        rectLength: n3(r.rect_length_mm),
        rectWidth: n3(r.rect_width_mm),
        outline: Array.isArray(outline) ? outline : [],
        stored: true,
      });
    }
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  return { lots, pieces, offcuts };
}

/** The company's offcut thresholds for a thickness; the contract's defaults if unset. */
async function offcutThresholds(db, companyId) {
  try {
    const [rows] = await db.query(
      `SELECT thickness_min_mm, thickness_max_mm, offcut_min_area_mm2, offcut_min_side_mm
         FROM cf_cut_settings WHERE company_id = ? AND deleted_at IS NULL ORDER BY id`,
      [companyId],
    );
    return (t) => {
      const band = rows.find((r) => r.thickness_min_mm != null && r.thickness_max_mm != null
        && Number(t) >= Number(r.thickness_min_mm) && Number(t) <= Number(r.thickness_max_mm));
      const def = rows.find((r) => r.thickness_min_mm == null && r.thickness_max_mm == null);
      const r = band ?? def;
      return {
        minOffcutArea: r?.offcut_min_area_mm2 != null ? Number(r.offcut_min_area_mm2) : DEFAULT_MIN_AREA,
        minOffcutSide: r?.offcut_min_side_mm != null ? Number(r.offcut_min_side_mm) : DEFAULT_MIN_SIDE,
      };
    };
  } catch (e) {
    if (!isMissingColumn(e) && !isMissingTable(e)) throw e;
    return () => ({ minOffcutArea: DEFAULT_MIN_AREA, minOffcutSide: DEFAULT_MIN_SIDE });
  }
}

const hasLayout = (pcs) => pcs.length > 0 && pcs.every((p) => p.x != null && p.y != null);

/** Stored offcuts, or — when none are stored — the ones the geometry finds. */
function offcutsFor(lot, pcs, stored, thresholds) {
  if (stored?.length) return stored;
  const a = analyseNest({
    length: Number(lot.length_mm),
    width: Number(lot.width_mm),
    kerf: Number(lot.kerf_mm ?? 0),
    seqGapMin: Number(lot.seq_gap_min_mm ?? 0),
    pieces: pcs,
    ...thresholds(lot.thickness_mm),
  });
  return a.offcuts.map((o, n) => ({ ...o, offcutNo: `${lot.lot_no}-${letters(n)}` }));
}

/** A, B, … Z, AA, AB … — the contract's `<lotNo>-A` suffix. */
function letters(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function dxfFor(lot, pcs, offcuts) {
  return nestToDxf({
    lot: {
      lotNo: lot.lot_no,
      plateCode: lot.plate_code ?? lot.plate_name ?? '',
      thickness: lot.thickness_mm != null ? Number(lot.thickness_mm) : null,
      grade: lot.grade ?? '',
      length: Number(lot.length_mm),
      width: Number(lot.width_mm),
    },
    pieces: pcs,
    offcuts,
  });
}

/**
 * One nest's DXF.
 * @returns {Promise<{ filename: string, buffer: Buffer }>}
 */
export async function lotDxf(db, companyId, lineId, lotId) {
  const line = await requireLine(db, companyId, lineId);
  const { lots, pieces, offcuts } = await loadLots(db, companyId, lineId, Number(lotId));
  const lot = lots[0];
  if (!lot) throw notFound('Plate lot');
  const pcs = pieces.get(lot.id) ?? [];
  if (!hasLayout(pcs)) {
    throw invalid('NO_LAYOUT', `Nest ${lot.lot_no} has no layout of ours — use the program it came from for its CNC file.`);
  }
  const thresholds = offcuts.get(lot.id)?.length ? null : await offcutThresholds(db, companyId);
  const oc = offcutsFor(lot, pcs, offcuts.get(lot.id), thresholds);
  return { filename: `${baseName(line, lot)}.dxf`, buffer: Buffer.from(dxfFor(lot, pcs, oc), 'latin1') };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Every nest of a line: one DXF per lot that has a layout, plus nests.csv.
 * @returns {Promise<{ filename: string, buffer: Buffer }>}
 */
export async function lineCncZip(db, companyId, lineId) {
  const line = await requireLine(db, companyId, lineId);
  const { lots, pieces, offcuts } = await loadLots(db, companyId, lineId);
  const needsThresholds = lots.some((l) => !offcuts.get(l.id)?.length && hasLayout(pieces.get(l.id) ?? []));
  const thresholds = needsThresholds ? await offcutThresholds(db, companyId) : null;

  const zip = new JSZip();
  const header = ['Nest', 'Plate', 'Thickness mm', 'Grade', 'Material', 'Length mm', 'Width mm', 'Origin',
    'Verdict', 'Pieces', 'Parts area m2', 'Utilisation %', 'Offcuts', 'File', 'Note'];
  const rows = [header];
  for (const lot of lots) {
    const pcs = pieces.get(lot.id) ?? [];
    const plateArea = Number(lot.length_mm) * Number(lot.width_mm);
    const partsArea = pcs.reduce((a, p) => a + p.length * p.width, 0);
    const laid = hasLayout(pcs);
    let file = '';
    let note = '';
    let oc = offcuts.get(lot.id) ?? [];
    if (laid) {
      oc = offcutsFor(lot, pcs, oc, thresholds);
      file = `${baseName(line, lot)}.dxf`;
      zip.file(file, Buffer.from(dxfFor(lot, pcs, oc), 'latin1'));
    } else {
      note = pcs.length ? 'no layout — use the program it came from' : 'no pieces on this plate';
    }
    rows.push([
      lot.lot_no,
      lot.plate_code ?? lot.plate_name ?? '',
      n3(lot.thickness_mm),
      lot.grade ?? '',
      lot.material ?? '',
      n3(lot.length_mm),
      n3(lot.width_mm),
      lot.origin ?? 'auto',
      lot.check_verdict ?? '',
      pcs.length,
      (partsArea / 1e6).toFixed(3),
      plateArea > 0 ? ((100 * partsArea) / plateArea).toFixed(1) : '',
      oc.map((o) => o.offcutNo).filter(Boolean).join(' '),
      file,
      note,
    ]);
  }
  // A BOM so Excel opens the dashes and codes as UTF-8.
  zip.file('nests.csv', `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { filename: `${safe(line.order_code)}-L${safe(line.line_no)}-nesting-cnc.zip`, buffer };
}
