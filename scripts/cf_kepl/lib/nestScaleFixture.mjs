/**
 * nestScaleFixture.mjs — an order line THE SIZE OF THE KEPL BRIDGE ORDER in the database, for the
 * suites that drive the real services at scale (nest_v2_scale_test.mjs, nest_soak_test.mjs).
 *
 * The job is lib/nestScaleJob.mjs (~6,000 pieces of ~250 cut plates in eight thicknesses, 30 % of
 * them drawn, plates of 12000 × 2500 and 6300 × 2500). IT OWNS EVERYTHING IT USES — its own
 * thicknesses (t + 0.137, which nothing else in the company has), cut settings, plates, grade,
 * order, line, part rows, cut plates and drawings, every code tagged — and is written in bulk
 * (a dozen statements). The caller runs it inside a transaction and rolls back.
 */
import { insertRows } from '../../../apps/cf_erp/lib/db.js';
import { readPartDrawing } from '../../../apps/cf_erp/services/partGeometry.js';
import { cutPlaces } from '../../../apps/cf_erp/lib/cutPlaces.js';
import { normMark } from '../../../apps/cf_erp/services/partDrawingService.js';
import { shapeToPartDxf } from './nestDxfFixtures.mjs';
import { scaleGroups } from './nestScaleJob.mjs';

const DENSITY = 7850;

export async function buildScaleFixture(conn, { company: COMPANY = 2, tag, pieces = 6000, parts = 250, plates = 125 } = {}) {
  const groups = scaleGroups({ pieces, parts, plates });
  const places = (await cutPlaces(conn, COMPANY)).plate;
  if (!places.blanksNodeId || !places.stockNodeIds.length) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces / raw plates (Setup › Cutting).`);
  const cutNode = places.blanksNodeId; const plateNode = Math.min(...places.stockNodeIds);
  const spec = {};
  for (const [code, type] of [['THICKNESS', 'number'], ['LENGTH', 'number'], ['WIDTH', 'number'], ['GRADE', 'option'], ['MATERIAL', 'option'], ['DENSITY', 'number'], ['DRAWING_MARK', 'text']]) {
    const [[sp]] = await conn.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    spec[code] = sp ? sp.id : (await conn.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, code, type]))[0].insertId;
  }
  const grade = (await conn.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, spec.GRADE, `${tag}-G`]))[0].insertId;
  const mat = (await conn.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, spec.MATERIAL, `${tag}-STEEL`]))[0].insertId;
  const [node] = await conn.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 0, 'item', ?, ?)", [COMPANY, `${tag}-PARTS`, `${tag} parts`]);
  const partNode = node.insertId;

  // Masters in bulk, their ids read back by code (AUTO_INCREMENT is not contiguous everywhere).
  const masters = [];                                // [code, name, classificationId, itemType, listPrice]
  const add = (code, name, cls, type, price = null) => { masters.push([code, name, cls, type, price]); return code; };
  const root = add(`${tag}-ROOT`, 'Nest v2 scale assembly', partNode, 'temporary');
  for (const g of groups) {
    g.t = g.thickness + 0.137;                       // a thickness nothing else in the company has
    g.plateCodes = { A: add(`${tag}-P${g.thickness}A`, `scale plate ${g.thickness} 12000`, plateNode, 'catalog', 62000), B: add(`${tag}-P${g.thickness}B`, `scale plate ${g.thickness} 6300`, plateNode, 'catalog', 62000) };
    g.parts.forEach((p, i) => { p.rowCode = add(`${tag}-R${g.thickness}-${i}`, 'scale part', partNode, 'temporary'); p.cpCode = add(`${tag}-C${g.thickness}-${i}`, 'scale cut plate', cutNode, 'temporary'); });
  }
  await insertRows(conn, 'cf_master_records', ['company_id', 'record_kind', 'code', 'name', 'classification_id', 'status'], masters.map((m) => [COMPANY, 'item', m[0], m[1], m[2], 'active']), 500);
  const [idRows] = await conn.query('SELECT id, code FROM cf_master_records WHERE company_id = ? AND code LIKE ? AND deleted_at IS NULL', [COMPANY, `${tag}-%`]);
  const id = new Map(idRows.map((r) => [r.code, Number(r.id)]));

  await insertRows(conn, 'cf_item_details', ['master_id', 'company_id', 'item_type', 'tracked_by', 'uom', 'sourcing', 'owner_order_line_id', 'list_price', 'price_basis'],
    masters.map((m) => [id.get(m[0]), COMPANY, m[3], 'quantity', 'nos', m[3] === 'temporary' ? 'make' : 'stock', null, m[4], m[4] == null ? 'unit' : 'tonne']), 500);
  const [o] = await conn.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Nest v2 scale fixture', 'confirmed')", [COMPANY, `${tag}-SO`]);
  const [l] = await conn.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, id.get(root), id.get(root)]);
  const lineId = l.insertId;
  await conn.query("UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND item_type = 'temporary' AND master_id IN (?)", [lineId, COMPANY, masters.filter((m) => m[3] === 'temporary').map((m) => id.get(m[0]))]);

  const vals = [];
  const num = (subject, code, v) => vals.push([COMPANY, spec[code], 'master', subject, v, null, null, 'entered']);
  const opt = (subject, code, v) => vals.push([COMPANY, spec[code], 'master', subject, null, v, null, 'entered']);
  const txt = (subject, code, v) => vals.push([COMPANY, spec[code], 'master', subject, null, null, v, 'entered']);
  const steel = (subject, t, L, W) => { num(subject, 'THICKNESS', t); num(subject, 'LENGTH', L); num(subject, 'WIDTH', W); opt(subject, 'GRADE', grade); opt(subject, 'MATERIAL', mat); num(subject, 'DENSITY', DENSITY); };
  const boms = [[id.get(root)]];
  const settings = [];
  for (const g of groups) {
    steel(id.get(g.plateCodes.A), g.t, 12000, 2500); steel(id.get(g.plateCodes.B), g.t, 6300, 2500);
    settings.push([COMPANY, g.t, g.t, g.kerf, 5, 8, 100, 50, 50, 0]);
    for (const p of g.parts) {
      // The line states a cut plate's LENGTH ≥ WIDTH; a drawing may lie the other way.
      p.L = Math.max(p.length, p.width); p.W = Math.min(p.length, p.width);
      num(id.get(p.rowCode), 'THICKNESS', g.t); num(id.get(p.rowCode), 'LENGTH', p.L); num(id.get(p.rowCode), 'WIDTH', p.W); num(id.get(p.rowCode), 'DENSITY', DENSITY); txt(id.get(p.rowCode), 'DRAWING_MARK', p.rowCode);
      steel(id.get(p.cpCode), g.t, p.L, p.W);
      boms.push([id.get(p.rowCode)], [id.get(p.cpCode)]);
    }
  }
  await insertRows(conn, 'cf_cut_settings', ['company_id', 'thickness_min_mm', 'thickness_max_mm', 'kerf_mm', 'seq_gap_min_mm', 'seq_gap_max_mm', 'order_margin_length_mm', 'order_margin_width_mm', 'order_step_mm', 'guillotine'], settings, 50);
  await insertRows(conn, 'cf_spec_values', ['company_id', 'specification_id', 'subject_type', 'subject_id', 'value_number', 'option_id', 'value_text', 'source'], vals, 1000);
  await insertRows(conn, 'cf_boms', ['company_id', 'parent_id', 'bom_type', 'status'], boms.map(([parent]) => [COMPANY, parent, 'custom', 'active']), 500);
  const [bomRows] = await conn.query('SELECT id, parent_id FROM cf_boms WHERE company_id = ? AND parent_id IN (?) AND deleted_at IS NULL', [COMPANY, boms.map((b) => b[0])]);
  const bomOf = new Map(bomRows.map((r) => [Number(r.parent_id), Number(r.id)]));
  const lines = [];
  let n = 0;
  for (const g of groups) {
    for (const p of g.parts) {
      n += 1;
      lines.push([COMPANY, bomOf.get(id.get(root)), n, id.get(p.rowCode), id.get(p.rowCode), n, p.qty]);
      lines.push([COMPANY, bomOf.get(id.get(p.rowCode)), 1, id.get(p.cpCode), id.get(p.cpCode), 1, 1]);
      lines.push([COMPANY, bomOf.get(id.get(p.cpCode)), 1, id.get(g.plateCodes.A), id.get(g.plateCodes.A), 1, (p.L * p.W) / (12000 * 2500)]);
    }
  }
  await insertRows(conn, 'cf_bom_lines', ['company_id', 'bom_id', 'line_no', 'child_id', 'design_id', 'position', 'quantity'], lines, 1000);

  const drawings = [];
  for (const g of groups) {
    for (const p of g.parts) {
      if (!p.shape) continue;
      const text = shapeToPartDxf(p.shape);
      const geo = readPartDrawing(text).geometry;
      drawings.push([COMPANY, lineId, p.rowCode, normMark(p.rowCode), `${p.rowCode}.dxf`, 'dxf', geo.lengthMm, geo.widthMm, geo.areaMm2, geo.cutLengthMm, geo.piercings, geo.holes, geo.innerCuts, JSON.stringify(geo), text]);
    }
  }
  await insertRows(conn, 'cf_part_drawings', ['company_id', 'order_line_id', 'mark', 'mark_norm', 'file_name', 'file_kind', 'length_mm', 'width_mm', 'area_mm2', 'cut_length_mm', 'piercings', 'holes', 'inner_cuts', 'geometry_json', 'dxf_text'], drawings, 50);
  for (const g of groups) for (const p of g.parts) { p.cutPlateId = id.get(p.cpCode); p.group = g; }
  return { groups, lineId, orderId: o.insertId, pieces: groups.reduce((a, g) => a + g.parts.reduce((b, p) => b + p.qty, 0), 0), parts: groups.flatMap((g) => g.parts), drawn: drawings.length };
}

