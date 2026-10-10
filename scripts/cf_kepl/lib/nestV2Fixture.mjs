/**
 * nestV2Fixture.mjs — the order line the Nesting v2 suites nest (nest_upload_test.mjs and friends).
 *
 * IT OWNS EVERYTHING IT USES: its own classification node for the parts, grades, material, catalog
 * plates, cut settings, order, line, part rows, cut plates and part drawings, at a thickness
 * (14.137 mm) nothing else in the company has and every code tagged with a run id. The caller runs
 * it inside a transaction and rolls back. The only things read from the tenant are WHERE cut
 * plates and raw plates are filed (Setup › Cutting) and the specifications by code.
 *
 *   root (the line's item)
 *     └─ part row  ×qty   (DRAWING_MARK, LENGTH, WIDTH — a drawing is matched to it by its mark)
 *          └─ cut plate ×1  (the rectangle round the part: THICKNESS, LENGTH, WIDTH, GRADE, MATERIAL)
 *               └─ raw plate (area fraction, until nesting says)
 *
 * The parts are bridge-girder shapes from nestDxfFixtures (a gusset, an angle, a sniped stiffener,
 * a splice plate with drilled holes, a frame with a window) plus plain rectangles.
 */
import { girderShapes, rectShape, shapeToPartDxf, makeNestDxf } from './nestDxfFixtures.mjs';
import { readPartDrawing } from '../../../apps/cf_erp/services/partGeometry.js';
import { cutPlaces } from '../../../apps/cf_erp/lib/cutPlaces.js';
import { normMark } from '../../../apps/cf_erp/services/partDrawingService.js';

export const T = 14.137;
export const DENSITY = 7850;

/** suffix → { shape, length, width (the cut plate's LENGTH ≥ WIDTH as the line states them), qty, grade, drawn, manual } */
export function partList() {
  const g = girderShapes();
  return {
    G: { shape: g.gusset, length: 520, width: 320, qty: 6, grade: 'A', drawn: true },
    A: { shape: g.angle, length: 500, width: 400, qty: 4, grade: 'A', drawn: true },        // drawn 400 × 500: the drawing is turned
    S: { shape: g.stiffener, length: 900, width: 180, qty: 8, grade: 'A', drawn: true },    // drawn 180 × 900
    P: { shape: g.splice, length: 700, width: 400, qty: 4, grade: 'A', drawn: true },       // 12 drilled holes
    F: { shape: g.frame, length: 800, width: 600, qty: 2, grade: 'A', drawn: true },        // a window
    H: { shape: g.shim, length: 300, width: 180, qty: 4, grade: 'A', drawn: false },
    R: { shape: rectShape(1200, 400), length: 1200, width: 400, qty: 5, grade: 'A', drawn: false },
    X1: { shape: rectShape(350, 350), length: 350, width: 350, qty: 1, grade: 'A', drawn: false },
    X2: { shape: rectShape(350, 350), length: 350, width: 350, qty: 1, grade: 'A', drawn: false },
    B: { shape: rectShape(600, 250), length: 600, width: 250, qty: 2, grade: 'B', drawn: false },
    M: { shape: rectShape(250, 200), length: 250, width: 200, qty: 2, grade: 'A', drawn: false, manual: true },
  };
}

export async function buildFixture(db, { company = 2, drawings = true, scale = 1, tagPrefix = 'NV' } = {}) {
  const COMPANY = company;
  const tag = `${tagPrefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase()}`;
  const places = (await cutPlaces(db, COMPANY)).plate;
  if (!places.blanksNodeId || !places.stockNodeIds.length) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces / raw plates (Setup › Cutting).`);
  const cutNode = places.blanksNodeId;
  const plateNode = Math.min(...places.stockNodeIds);

  const specByCode = async (code, dataType) => {
    const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (s) return s.id;
    const [r] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, code, dataType]);
    return r.insertId;
  };
  const spec = {};
  for (const [code, type] of [['THICKNESS', 'number'], ['LENGTH', 'number'], ['WIDTH', 'number'], ['GRADE', 'option'], ['MATERIAL', 'option'], ['DENSITY', 'number'], ['NEST_MANUAL', 'boolean'], ['DRAWING_MARK', 'text'], ['CUT_LENGTH', 'number'], ['PIERCINGS', 'number']]) spec[code] = await specByCode(code, type);
  const option = async (specId, value) => (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, value]))[0].insertId;
  const GA = `${tag}-GA`; const GB = `${tag}-GB`;
  const grade = { A: await option(spec.GRADE, GA), B: await option(spec.GRADE, GB) };
  const mat = await option(spec.MATERIAL, `${tag}-STEEL`);

  const master = async ({ code, name, classificationId, itemType, ownerLineId = null, listPrice = null }) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, code, name, classificationId]);
    await db.query('INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id, list_price, price_basis) VALUES (?, ?, ?, \'quantity\', \'nos\', ?, ?, ?, ?)',
      [m.insertId, COMPANY, itemType, itemType === 'temporary' ? 'make' : 'stock', ownerLineId, listPrice, listPrice == null ? 'unit' : 'tonne']);
    return m.insertId;
  };
  const num = (v) => ({ n: v });
  const setVals = async (subjectId, vals) => {
    const rows = vals.filter(([, v]) => v != null).map(([specId, v]) => [COMPANY, specId, 'master', subjectId, v.n ?? null, v.o ?? null, v.b ?? null, v.t ?? null, 'entered']);
    if (rows.length) await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_bool, value_text, source) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`, rows.flat());
  };
  const steel = (t, l, w, g) => [[spec.THICKNESS, num(t)], [spec.LENGTH, num(l)], [spec.WIDTH, num(w)], [spec.GRADE, { o: grade[g] }], [spec.MATERIAL, { o: mat }], [spec.DENSITY, num(DENSITY)]];
  const bomLine = async (parentId, childId, quantity, lineNo) => {
    let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
    if (!bom) bom = { id: (await db.query("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'custom', 'active')", [COMPANY, parentId]))[0].insertId };
    return (await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]))[0].insertId;
  };

  // Its own cut settings for its own thickness: 3 mm kerf, whatever the company's bands say.
  // (A second fixture in the same transaction shares the row.)
  const [[band]] = await db.query('SELECT id FROM cf_cut_settings WHERE company_id = ? AND thickness_min_mm = ? AND thickness_max_mm = ? AND deleted_at IS NULL', [COMPANY, T, T]);
  if (!band) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, T, T]);

  // Catalog plates. PS, PB and PW are the same size: only the steel tells them apart.
  const plate = async (sfx, t, l, w, g, price) => {
    const id = await master({ code: `${tag}-${sfx}`, name: `Nest v2 fixture plate ${sfx}`, classificationId: plateNode, itemType: 'catalog', listPrice: price });
    await setVals(id, steel(t, l, w, g));
    return id;
  };
  const plates = {
    PA: await plate('PA', T, 6000, 2000, 'A', 62000),
    PS: await plate('PS', T, 3000, 1500, 'A', 62000),
    PB: await plate('PB', T, 3000, 1500, 'B', 71000),
    PW: await plate('PW', T + 2, 3000, 1500, 'A', 62000),
  };
  const plateSize = { PA: [6000, 2000], PS: [3000, 1500], PB: [3000, 1500], PW: [3000, 1500] };

  const [node] = await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 0, 'item', ?, ?)", [COMPANY, `${tag}-PARTS`, `${tag} parts`]);
  const partNode = node.insertId;

  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Nest v2 fixture', 'confirmed')", [COMPANY, `${tag}-SO`]);
  const root = await master({ code: `${tag}-ROOT`, name: 'Nest v2 fixture assembly', classificationId: partNode, itemType: 'temporary' });
  const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  const parts = partList();
  const cut = {}; const partRow = {}; const plateLine = {}; const mark = {};
  let n = 0;
  for (const [sfx, p] of Object.entries(parts)) {
    n += 1;
    const qty = Math.round(p.qty * Math.max(1, Math.round(scale)));
    p.qty = qty;
    mark[sfx] = `${tag}-${sfx}`;
    const row = await master({ code: `${tag}-PT-${sfx}`, name: `Nest v2 fixture part ${sfx}`, classificationId: partNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(row, [[spec.THICKNESS, num(T)], [spec.LENGTH, num(p.length)], [spec.WIDTH, num(p.width)], [spec.DENSITY, num(DENSITY)], [spec.DRAWING_MARK, { t: mark[sfx] }]]);
    const cp = await master({ code: `${tag}-C${sfx}`, name: `Nest v2 fixture cut plate ${sfx}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(cp, steel(T, p.length, p.width, p.grade));
    if (p.manual) await setVals(cp, [[spec.NEST_MANUAL, { b: 1 }]]);
    await bomLine(root, row, qty, n);
    await bomLine(row, cp, 1, 1);
    const target = p.grade === 'B' ? 'PB' : 'PS';
    plateLine[sfx] = await bomLine(cp, plates[target], (p.length * p.width) / (plateSize[target][0] * plateSize[target][1]), 1);
    cut[sfx] = cp; partRow[sfx] = row;
  }

  const fx = {
    company: COMPANY, tag, GA, GB, lineId, orderId: o.insertId, root, partNode, spec, plates, plateSize, parts, cut, partRow, plateLine, mark,
    code: (sfx) => `${tag}-C${sfx}`,
    plateCode: (sfx) => `${tag}-${sfx}`,
    sfxOfCut: (id) => Object.keys(cut).find((k) => Number(cut[k]) === Number(id)) ?? null,
    drawings: false, scale: Math.max(1, Math.round(scale)),
  };
  if (drawings) await addDrawings(db, fx);
  return fx;
}

/** The parts' own DXF drawings, filed on the line under their drawing marks (what an upload would store). */
export async function addDrawings(db, fx, only = null) {
  for (const [sfx, p] of Object.entries(fx.parts)) {
    if (!p.drawn || (only && !only.includes(sfx))) continue;
    const text = shapeToPartDxf(p.shape);
    const g = readPartDrawing(text).geometry;
    await db.query(
      `INSERT INTO cf_part_drawings (company_id, order_line_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, dxf_text)
       VALUES (?, ?, ?, ?, ?, 'dxf', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fx.company, fx.lineId, fx.mark[sfx], normMark(fx.mark[sfx]), `${fx.mark[sfx]}.dxf`, g.lengthMm, g.widthMm, g.areaMm2, g.cutLengthMm, g.piercings, g.holes, g.innerCuts, JSON.stringify(g), text],
    );
  }
  fx.drawings = true;
}

export async function removeDrawings(db, fx) {
  await db.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [fx.company, fx.lineId]);
  fx.drawings = false;
}

/* ───────────────────────────── the customer's files ───────────────────────────── */

/** One part on a plate: [suffix, x, y, rotationDeg?, mirrored?] → what makeNestDxf takes, labelled by its cut plate code. */
export const place = (fx, sfx, x, y, rotationDeg = 0, mirrored = false, label = undefined) => ({
  sfx, shape: fx.parts[sfx].shape, x, y, rotationDeg, mirrored, label: label === undefined ? fx.code(sfx) : label,
});

/** Parts laid in rows, left to right, wrapping: items [[sfx, rotationDeg?, mirrored?]] → placed parts. */
export function rows(fx, items, plate, { gap = 25, margin = 20, x0 = null, y0 = null } = {}) {
  let x = x0 ?? margin; let y = y0 ?? margin; let shelf = 0;
  const out = [];
  for (const [sfx, rot = 0, mir = false] of items) {
    const p = fx.parts[sfx];
    const b = turnedBox(p.shape, rot, mir);
    if (x + b.l > plate.length - margin + 1e-6 && x > (x0 ?? margin)) { x = x0 ?? margin; y += shelf + gap; shelf = 0; }
    if (y + b.w > plate.width - margin + 1e-6) throw new Error(`rows: ${sfx} does not fit on the ${plate.length} x ${plate.width} plate`);
    out.push(place(fx, sfx, x, y, rot, mir));
    x += b.l + gap; shelf = Math.max(shelf, b.w);
  }
  return out;
}

function turnedBox(shape, rot, mir) {
  // The fixture generator's own layout rule, on one part: its box once mirrored and turned.
  const flat = shape.loops[0].circle ? null : shape.loops[0].v.map(([px, py]) => [px, py]);
  const pts = flat ?? (() => { const [cx, cy, r] = shape.loops[0].circle; return [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]; })();
  const t = (rot * Math.PI) / 180;
  const q = pts.map(([px, py]) => { const nx = mir ? -px : px; return [nx * Math.cos(t) - py * Math.sin(t), nx * Math.sin(t) + py * Math.cos(t)]; });
  // Arcs bulge past their corners only on the web shape, which this fixture does not nest.
  const xs = q.map((p) => p[0]); const ys = q.map((p) => p[1]);
  return { l: Math.max(...xs) - Math.min(...xs), w: Math.max(...ys) - Math.min(...ys) };
}

/** A customer file: { filename, file (base64), text, parts, plate }. */
export function nestFile(filename, plate, parts, { style = 'polyline', options = {}, seed = 7 } = {}) {
  const text = makeNestDxf({ plate, parts, style, options, seed });
  return { filename, file: Buffer.from(text, 'latin1').toString('base64'), text, parts, plate, style };
}

/** How many of each cut plate suffix a set of files places. */
export function countsOf(files) {
  const out = {};
  for (const f of files) for (const p of f.parts) if (p.sfx) out[p.sfx] = (out[p.sfx] ?? 0) + 1;
  return out;
}

/**
 * THREE DIFFERENT COMPLETE NESTINGS of the fixture line — different plate counts, arrangements and
 * the ways different nesting programs write a file. Every one covers every piece of the line once
 * (NEST_MANUAL pieces too: they may sit on an imported nest).
 *
 *   A  two plates:   everything of grade A on one 6000 × 2000 (polyline, labelled), grade B on its own.
 *   B  five plates:  3000 × 1500 plates; blocks, loose segments with no plate drawn, inches;
 *                    free angles and mirrored parts.
 *   C  three plates: 6000 × 2000 as a common-cut nest with the shims in the frames' windows, a
 *                    noisy file (lead-ins, pierce marks, a title block), grade B on its own.
 */
export function nestings(fx) {
  const PA = { length: 6000, width: 2000 }; const PS = { length: 3000, width: 1500 };
  const rep = (sfx, n, rot = 0, mir = false) => Array.from({ length: n }, () => [sfx, rot, mir]);
  // One copy nests the BASE quantities; a fixture built at scale k gets k copies of every file.
  const q = Object.fromEntries(Object.entries(partList()).map(([k, p]) => [k, p.qty]));
  const copies = Math.max(1, Math.round(fx.scale ?? 1));
  const A = []; const B = []; const C = [];
  for (let c = 0; c < copies; c += 1) {
    const t = copies === 1 ? fx.tag : `${fx.tag}k${c + 1}`;
    // A second copy is the same plates drawn 2 mm over: another plate cut the same way is another FILE
    // (the same bytes twice is refused as the same plate uploaded twice).
    const mk = (name, plate, parts, o) => nestFile(name, plate, c ? parts.map((p) => ({ ...p, x: p.x + 2 * c })) : parts, o);

    // ---- A ----
    A.push(
      mk(`${t}-A1_${T}mm_6000x2000.dxf`, PA, rows(fx, [
        ...rep('R', 4), ['P'], ['H'], ...rep('F', q.F), ['R'], ...rep('P', 3), ['A', 90], ['X1'], ...rep('A', 3, 90), ...rep('G', q.G), ['X2'], ...rep('M', q.M),
        ...rep('S', 6, 90), ['H'], ...rep('S', 2, 90), ...rep('H', 2),
      ], PA)),
      mk(`${t}-A2_${T}mm_3000x1500.dxf`, PS, rows(fx, rep('B', q.B), PS)),
    );

    // ---- B ----
    B.push(
      mk(`${t}-B1_${T}mm_3000x1500.dxf`, PS, rows(fx, [...rep('R', 2), ['H'], ...rep('S', q.S, 90), ...rep('H', 3)], PS), { style: 'blocks' }),
      mk(`${t}-B2.dxf`, PS, rows(fx, [...rep('R', 2), ['X1'], ...rep('P', q.P), ['X2']], PS), { style: 'segments' }),          // no plate drawn: the plate is named in the request
      mk(`${t}-B3_${T}mm_3000x1500.dxf`, PS, rows(fx, [...rep('F', q.F), ['R'], ...rep('A', 2), ...rep('A', 2, 0, true), ...rep('M', q.M)], PS), { style: 'inches' }),
      mk(`${t}-B4_${T}mm_3000x1500.dxf`, PS, rows(fx, [...rep('G', 3, 17), ...rep('G', 3, 197, true)], PS, { gap: 40 })),  // free angles, some flipped
      mk(`${t}-B5_${T}mm_3000x1500.dxf`, PS, rows(fx, rep('B', q.B, 90), PS)),
    );

    // ---- C ----
    // Rectangles touching: one line cut once for two parts. Frames with a shim in each window.
    const c1 = [];
    // Four in a row share three cuts. The fifth stands clear: two common cuts CROSSING (a 2 × 2 block
    // of equal parts) is something lib/nestDxfReader.js does not read yet — it returns one part.
    for (let i = 0; i < q.R; i += 1) c1.push(i < 4 ? place(fx, 'R', 20 + i * 1200, 20) : place(fx, 'R', 20 + (i - 4) * 1230, 460));
    let fxX = 20;
    for (let i = 0; i < q.F; i += 1) {
      c1.push(place(fx, 'F', fxX, 900));
      c1.push(place(fx, 'H', fxX + 250, 900 + 210));
      fxX += 800 + 30;
    }
    const tail = rows(fx, [...rep('H', q.H - q.F), ...rep('P', q.P), ['X1'], ['X2'], ...rep('M', q.M), ...rep('G', q.G, 180)], PA, { x0: fxX, y0: 900 });
    C.push(
      mk(`${t}-C1_${T}mm_6000x2000.dxf`, PA, [...c1, ...tail], { style: 'commoncut' }),
      mk(`${t}-C2.dxf`, PS, rows(fx, [...rep('S', q.S), ...rep('A', q.A, 90)], PS), {
        style: 'noisy', options: { title: [`PL ${T} x 3000 x 1500`, `NEST NO: ${t}-C2`, 'DATE 10-10-2026'] },
      }),
      mk(`${t}-C3_${T}mm_3000x1500.dxf`, PS, rows(fx, rep('B', q.B), PS, { margin: 60 })),
    );
  }
  return { A, B, C };
}

/**
 * A plan (planNesting's answer) with everything that differs from run to run taken out — ids
 * become the fixture's own names, the run tag becomes TAG, timings go — so two plans of the same
 * fixture can be compared as text. For the golden snapshot (golden/nest_v2_plan_golden.json).
 */
export function normalisePlan(plan, fx) {
  const name = new Map();
  for (const [sfx, id] of Object.entries(fx.cut)) name.set(Number(id), `cut:${sfx}`);
  for (const [sfx, id] of Object.entries(fx.plates)) name.set(Number(id), `plate:${sfx}`);
  const ID_KEYS = new Set(['cutPlateId', 'plateItemId', 'id', 'orderId']);
  const DROP = new Set(['elapsedMs', 'packMs', 'workers', 'floorMs', 'tookMs']);
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) { if (!DROP.has(k)) out[k] = walk(x, k); }
      return out;
    }
    if (ID_KEYS.has(key) && typeof v === 'number') return name.get(v) ?? (key === 'id' || key === 'orderId' ? '#' : v);
    return v;
  };
  let text = JSON.stringify(walk(plan, null)).replaceAll(fx.tag, 'TAG');
  // A sheet key carries the plate's id (pl123): its name instead.
  for (const [sfx, id] of Object.entries(fx.plates)) text = text.replaceAll('"pl' + id + '"', '"pl:' + sfx + '"');
  return JSON.parse(text);
}
