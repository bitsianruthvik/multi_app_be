/**
 * nest-reference-files.mjs — CF_ERP. A set of REFERENCE nesting DXF files (one DXF = one raw
 * plate), written the ways real nesting programs and real drawing offices write them, and a
 * measure of how the "upload nesting files" feature (POST …/nesting/files) reads each one.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nest-reference-files.mjs
 *
 * WHAT IT DOES, in ONE TRANSACTION THAT IS ROLLED BACK (local MySQL only):
 *   1. builds its OWN order line (prefix NRF: its own plates, order, line, part rows, cut pieces,
 *      drawings, cut settings; every tenant catalog plate is excluded from its automatic nesting);
 *   2. nests it automatically, accepts, and exports our own CNC DXF per plate (group a);
 *   3. writes every reference file to TM/NEST_REFERENCE_DXF/<group>/<file>;
 *   4. feeds every file through the upload PREVIEW (uploadNestFiles, dryRun) — nothing is saved;
 *   5. prints file → expected → answered → PASS / FAIL, and writes MANIFEST.md (the part of
 *      MANIFEST.md after the FINDINGS marker is written by hand and kept as it is).
 *
 * The expectation of a file is what the app SHOULD do with it, not what it does today: a FAIL is
 * a gap in the reader (lib/nestDxfReader.js) or the upload service (nestDxfImportService.js).
 * Exit code is 0 whatever the table says; it is 1 only when the script itself breaks.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This script is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const CNC = await imp('apps/cf_erp/services/cncExportService.js');
const DR = await imp('apps/cf_erp/services/partDrawingService.js');
const RD = await imp('apps/cf_erp/lib/nestDxfReader.js');
const PG = await imp('apps/cf_erp/services/partGeometry.js');
const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const OUT_DIR = path.resolve(BE, '..', 'NEST_REFERENCE_DXF');
const FINDINGS_MARK = '<!-- FINDINGS — written by hand; nest-reference-files.mjs keeps everything below this line -->';
const TAG = 'NRF';
const DENSITY = 7850;
const RAD = Math.PI / 180;
const Q = Math.tan(Math.PI / 8);            // the bulge of a quarter circle

/* ───────────────────────────── the line (the fixture) ───────────────────────────── */

const rectLoop = (l, w) => ({ v: [[0, 0], [l, 0], [l, w], [0, w]] });
const SHAPE = {
  // 600 × 300 with one corner coped (a concave quarter circle, R60).
  cope: { name: 'cope', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [600, 0], [600, 300], [60, 300, -Q], [0, 240]] }] },
  // 500 × 300 splice plate with a 3 × 2 pattern of 22 mm holes set to one side.
  holes: { name: 'holes', symmetry: { rot: 1, mirror: true }, loops: [rectLoop(500, 300), ...[60, 160, 260].flatMap((x) => [60, 240].map((y) => ({ circle: [x, y, 11] })))] },
  trap: { name: 'trap', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [520, 0], [400, 320], [60, 320]] }] },
  ell: { name: 'ell', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [400, 0], [400, 120], [120, 120], [120, 500], [0, 500]] }] },
  // A stiffener with one corner sniped — TWO different cut pieces have exactly this shape.
  snipe: { name: 'snipe', symmetry: { rot: 1, mirror: false }, loops: [{ v: [[0, 0], [180, 0], [180, 700], [35, 700], [0, 665]] }] },
  // 20 mm base plate: a 120 mm torch-cut opening and four 26 mm holes.
  base: { name: 'base', symmetry: { rot: 4, mirror: true }, loops: [rectLoop(450, 450), { circle: [225, 225, 60] }, ...[[60, 60], [390, 60], [390, 390], [60, 390]].map(([x, y]) => ({ circle: [x, y, 13] }))] },
};
const rectShape = (l, w) => D.rectShape(l, w);

/** key → { n, t, grade, length, width, qty, shape, drawn, cust (a customer's mark that is NOT one of our codes) } */
const PARTS = {
  COPE: { n: 1, t: 12, grade: 'E350', length: 600, width: 300, qty: 4, shape: SHAPE.cope, drawn: true, cust: 'PM-201' },
  HOLES: { n: 2, t: 12, grade: 'E350', length: 500, width: 300, qty: 2, shape: SHAPE.holes, drawn: true, cust: 'PM-202' },
  TRAP: { n: 3, t: 12, grade: 'E350', length: 520, width: 320, qty: 3, shape: SHAPE.trap, drawn: true, cust: 'PM-203' },
  ELL: { n: 4, t: 12, grade: 'E350', length: 500, width: 400, qty: 2, shape: SHAPE.ell, drawn: true, cust: 'PM-204' },   // drawn 400 × 500
  T1: { n: 5, t: 12, grade: 'E350', length: 700, width: 180, qty: 1, shape: SHAPE.snipe, drawn: true, cust: 'PM-205' },   // drawn 180 × 700
  T2: { n: 6, t: 12, grade: 'E350', length: 700, width: 180, qty: 1, shape: SHAPE.snipe, drawn: true, cust: 'PM-206' },   // the same shape as T1
  R1: { n: 7, t: 12, grade: 'E350', length: 1200, width: 400, qty: 5, shape: rectShape(1200, 400), drawn: false, cust: 'PM-207' },
  R2: { n: 8, t: 12, grade: 'E350', length: 800, width: 200, qty: 6, shape: rectShape(800, 200), drawn: false, cust: 'PM-208' },
  R3: { n: 9, t: 12, grade: 'E350', length: 300, width: 180, qty: 2, shape: rectShape(300, 180), drawn: false, cust: 'PM-209' },
  X1: { n: 10, t: 12, grade: 'E350', length: 350, width: 250, qty: 1, shape: rectShape(350, 250), drawn: false, cust: 'PM-210' },
  X2: { n: 11, t: 12, grade: 'E350', length: 350, width: 250, qty: 1, shape: rectShape(350, 250), drawn: false, cust: 'PM-211' },  // the same rectangle as X1
  B1: { n: 12, t: 12, grade: 'E250', length: 600, width: 250, qty: 2, shape: rectShape(600, 250), drawn: false, cust: 'PM-212' },
  K1: { n: 13, t: 20, grade: 'E350', length: 700, width: 350, qty: 2, shape: rectShape(700, 350), drawn: false, cust: 'PM-213' },
  BASE: { n: 14, t: 20, grade: 'E350', length: 450, width: 450, qty: 1, shape: SHAPE.base, drawn: true, cust: 'PM-214' },
  K3: { n: 15, t: 20, grade: 'E350', length: 300, width: 180, qty: 2, shape: rectShape(300, 180), drawn: false, cust: 'PM-215' },  // R3's rectangle, in 20 mm
};
const TWINS = new Set(['T1', 'T2', 'X1', 'X2']);
const STEEL_TWINS = new Set(['R3', 'K3']);            // the same shape in two thicknesses: the plate's steel settles it
const pad2 = (n) => String(n).padStart(2, '0');
const code = (k) => `${TAG}-CP-${pad2(PARTS[k].n)}`;
const mark = (k) => `${TAG}-MK-1${pad2(PARTS[k].n)}`;
const PLATES = {
  P12A: { code: `${TAG}-PL-12-E350-6000x2500`, t: 12, grade: 'E350', length: 6000, width: 2500 },
  P12S: { code: `${TAG}-PL-12-E350-3000x1500`, t: 12, grade: 'E350', length: 3000, width: 1500 },
  P12B: { code: `${TAG}-PL-12-E250-3000x1500`, t: 12, grade: 'E250', length: 3000, width: 1500 },
  P20S: { code: `${TAG}-PL-20-E350-3000x1500`, t: 20, grade: 'E350', length: 3000, width: 1500 },
};
const PS = { length: 3000, width: 1500 };
const PA = { length: 6000, width: 2500 };

async function buildFixture(db) {
  const [[left]] = await db.query("SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE ?", [COMPANY, `${TAG}-%`]);
  if (Number(left.n)) throw new Error(`${left.n} records with the prefix ${TAG}- already exist in company ${COMPANY} — an earlier run was committed. Remove them first.`);
  const places = (await cutPlaces(db, COMPANY)).plate;
  if (!places.blanksNodeId || !places.stockNodeIds.length) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces / raw plates (Setup › Cutting).`);
  const cutNode = places.blanksNodeId;
  const plateNode = Math.min(...places.stockNodeIds);

  // Tenant plates of one of our sizes would make "which plate" depend on the tenant's catalog: say so.
  const tenantPlates = await N.candidatePlates(db, COMPANY, places.stockNodeIds);
  const clash = tenantPlates.filter((p) => Object.values(PLATES).some((q) => (p.steel.length === q.length && p.steel.width === q.width) || (p.steel.length === q.width && p.steel.width === q.length)));
  if (clash.length) console.log(`  NOTE: ${clash.length} tenant catalog plate(s) are the size of a fixture plate (${clash.map((p) => p.code).join(', ')}) — plate matching may name them.`);

  const specByCode = async (c, dataType) => {
    const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, c]);
    if (s) return s.id;
    return (await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, c, c, dataType]))[0].insertId;
  };
  const spec = {};
  for (const [c, type] of [['THICKNESS', 'number'], ['LENGTH', 'number'], ['WIDTH', 'number'], ['GRADE', 'option'], ['MATERIAL', 'option'], ['DENSITY', 'number'], ['NEST_MANUAL', 'boolean'], ['DRAWING_MARK', 'text'], ['CUT_LENGTH', 'number'], ['PIERCINGS', 'number']]) spec[c] = await specByCode(c, type);
  // Grades are named as steel is named (E350, E250): the tenant's option when it has one, else ours.
  const option = async (specId, value) => {
    const [[o]] = await db.query('SELECT id FROM cf_spec_options WHERE company_id = ? AND specification_id = ? AND value = ? AND deleted_at IS NULL', [COMPANY, specId, value]);
    if (o) return o.id;
    return (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, value]))[0].insertId;
  };
  const grade = { E350: await option(spec.GRADE, 'E350'), E250: await option(spec.GRADE, 'E250') };
  const mat = await option(spec.MATERIAL, 'MS');

  const master = async ({ code: c, name, classificationId, itemType, ownerLineId = null, listPrice = null }) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, c, name, classificationId]);
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

  // Its own cut settings for its two thicknesses: 3 mm kerf, whatever the company's bands say.
  for (const t of [12, 20]) {
    const [[band]] = await db.query('SELECT id FROM cf_cut_settings WHERE company_id = ? AND thickness_min_mm = ? AND thickness_max_mm = ? AND deleted_at IS NULL', [COMPANY, t, t]);
    if (!band) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, t, t]);
  }

  const plates = {};
  for (const [k, p] of Object.entries(PLATES)) {
    plates[k] = await master({ code: p.code, name: `Nest reference plate ${k}`, classificationId: plateNode, itemType: 'catalog', listPrice: 62000 });
    await setVals(plates[k], steel(p.t, p.length, p.width, p.grade));
  }

  const [node] = await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 0, 'item', ?, ?)", [COMPANY, `${TAG}-PARTS`, `${TAG} nest reference parts`]);
  const partNode = node.insertId;
  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'Nest reference files', 'confirmed')", [COMPANY, `${TAG}-SO`]);
  const root = await master({ code: `${TAG}-ROOT`, name: 'Nest reference assembly', classificationId: partNode, itemType: 'temporary' });
  const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  const cut = {};
  for (const [k, p] of Object.entries(PARTS)) {
    const row = await master({ code: `${TAG}-PT-${pad2(p.n)}`, name: `Nest reference part ${k}`, classificationId: partNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(row, [[spec.THICKNESS, num(p.t)], [spec.LENGTH, num(p.length)], [spec.WIDTH, num(p.width)], [spec.DENSITY, num(DENSITY)], [spec.DRAWING_MARK, { t: mark(k) }]]);
    const cp = await master({ code: code(k), name: `Nest reference cut piece ${k}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(cp, steel(p.t, p.length, p.width, p.grade));
    await bomLine(root, row, p.qty, p.n);
    await bomLine(row, cp, 1, 1);
    const target = p.t === 20 ? 'P20S' : p.grade === 'E250' ? 'P12B' : 'P12S';
    await bomLine(cp, plates[target], (p.length * p.width) / (PLATES[target].length * PLATES[target].width), 1);
    cut[k] = cp;
    if (p.drawn) {
      const text = D.shapeToPartDxf(p.shape);
      const g = PG.readPartDrawing(text).geometry;
      await db.query(
        `INSERT INTO cf_part_drawings (company_id, order_line_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, dxf_text)
         VALUES (?, ?, ?, ?, ?, 'dxf', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [COMPANY, lineId, mark(k), DR.normMark(mark(k)), `${mark(k)}.dxf`, g.lengthMm, g.widthMm, g.areaMm2, g.cutLengthMm, g.piercings, g.holes, g.innerCuts, JSON.stringify(g), text],
      );
    }
  }
  // Automatic nesting may use ONLY the fixture's plates: every tenant plate is excluded on this line.
  const mine = new Set(Object.values(plates));
  const others = tenantPlates.filter((p) => !mine.has(p.id));
  if (others.length) await db.query(`INSERT INTO cf_nest_exclusions (company_id, order_line_id, kind, item_id) VALUES ${others.map(() => "(?, ?, 'plate', ?)").join(',')}`, others.flatMap((p) => [COMPANY, lineId, p.id]));
  return { lineId, orderId: o.insertId, cut, plates, keyOfCut: (id) => Object.keys(cut).find((k) => Number(cut[k]) === Number(id)) ?? null };
}

/* ───────────────────────────── writing DXF ───────────────────────────── */

const f = (n) => String(Number(Number(n).toFixed(6)));
const E = (...kv) => kv.map(String);
const LINE = (layer, p, q, extra = []) => E(0, 'LINE', 8, layer, ...extra, 10, f(p[0]), 20, f(p[1]), 11, f(q[0]), 21, f(q[1]));
const CIRCLE = (layer, c, r) => E(0, 'CIRCLE', 8, layer, 10, f(c[0]), 20, f(c[1]), 40, f(r));
const LWPOLY = (layer, v, closed = true) => E(0, 'LWPOLYLINE', 8, layer, 90, v.length, 70, closed ? 1 : 0, ...v.flatMap(([x, y, b]) => [10, f(x), 20, f(y), ...(b ? [42, f(b)] : [])]));
const POLY12 = (layer, v) => [E(0, 'POLYLINE', 8, layer, 66, 1, 10, 0, 20, 0, 30, 0, 70, 1), ...v.map(([x, y, b]) => E(0, 'VERTEX', 8, layer, 10, f(x), 20, f(y), 30, 0, ...(b ? [42, f(b)] : []))), E(0, 'SEQEND', 8, layer)].flat();
const TEXT = (layer, p, h, s, { rot = 0, centred = true } = {}) => E(0, 'TEXT', 8, layer, 10, f(p[0]), 20, f(p[1]), 40, f(h), 1, s, ...(rot ? [50, f(rot)] : []), ...(centred ? [72, 1, 11, f(p[0]), 21, f(p[1]), 73, 2] : []));
const MTEXT = (layer, p, h, s) => E(0, 'MTEXT', 8, layer, 10, f(p[0]), 20, f(p[1]), 40, f(h), 71, 5, 1, s);

/** The whole file. header: 'r2000' ($ACADVER + $INSUNITS) | 'r12' ($ACADVER AC1009, no units) | 'none' (no HEADER at all). */
function doc(entities, { header = 'r2000', insunits = 4, blocks = null, eol = '\r\n', pad = false, extraHeader = [] } = {}) {
  const out = [];
  if (header !== 'none') {
    out.push(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, header === 'r12' ? 'AC1009' : 'AC1015');
    if (header === 'r2000' && insunits != null) out.push(9, '$INSUNITS', 70, insunits);
    out.push(...extraHeader, 0, 'ENDSEC');
  }
  if (blocks) out.push(0, 'SECTION', 2, 'BLOCKS', ...blocks.flat(), 0, 'ENDSEC');
  out.push(0, 'SECTION', 2, 'ENTITIES', ...entities.flat(), 0, 'ENDSEC', 0, 'EOF');
  const lines = out.map(String);
  if (pad) for (let i = 0; i < lines.length; i += 2) lines[i] = lines[i].padStart(3, ' ');
  return `${lines.join(eol)}${eol}`;
}

/** A DXF text as { pre: [lines before ENTITIES' first entity], ents: [[code, value, …]], post } — to edit our own CNC export. */
function splitEntities(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i + 3 < lines.length; i += 2) if (lines[i].trim() === '0' && lines[i + 1].trim() === 'SECTION' && lines[i + 3].trim() === 'ENTITIES') { start = i + 4; break; }
  const ents = []; let i = start; let cur = null;
  for (; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim(); const v = lines[i + 1];
    if (c === '0' && v.trim() === 'ENDSEC') break;
    if (c === '0') { cur = [c, v]; ents.push(cur); } else cur.push(c, v);
  }
  return { pre: lines.slice(0, start), ents, post: lines.slice(i) };
}
const joinEntities = ({ pre, ents, post }) => [...pre, ...ents.flat(), ...post].join('\r\n');
const valOf = (ent, c) => { for (let i = 0; i < ent.length; i += 2) if (String(ent[i]).trim() === String(c)) return ent[i + 1]; return null; };

/** A shape's loops placed by THE PLACEMENT CONVENTION (lib/nestDxfReader.js placeRings), bulges kept. */
function placedLoops(shape, { x, y, rotationDeg = 0, mirrored = false }) {
  const flat0 = shape.loops.flatMap(D.flattenLoop);
  const b0 = flat0.reduce((b, [px, py]) => ({ x0: Math.min(b.x0, px), y0: Math.min(b.y0, py) }), { x0: Infinity, y0: Infinity });
  const flat = RD.placeRings([flat0], { x: 0, y: 0, rotationDeg, mirrored })[0];
  const t = rotationDeg * RAD;
  const q = Math.round(rotationDeg / 90);
  const exact = Math.abs(rotationDeg - q * 90) < 1e-9;
  const cos = exact ? [1, 0, -1, 0][((q % 4) + 4) % 4] : Math.cos(t);
  const sin = exact ? [0, 1, 0, -1][((q % 4) + 4) % 4] : Math.sin(t);
  const turn = ([px, py]) => { const nx = (px - b0.x0) * (mirrored ? -1 : 1); const ny = py - b0.y0; return [nx * cos - ny * sin, nx * sin + ny * cos]; };
  const t0 = turn(flat0[0]);
  const sx = flat[0][0] - t0[0] + x; const sy = flat[0][1] - t0[1] + y;
  const map = (p) => { const u = turn(p); return [u[0] + sx, u[1] + sy]; };
  return shape.loops.map((l) => (l.circle ? { circle: [...map(l.circle), l.circle[2]] } : { v: l.v.map(([px, py, b]) => [...map([px, py]), (b ?? 0) * (mirrored ? -1 : 1)]) }));
}
/** The widest stretch of steel on a few lines through the part: where its label goes. */
function labelPoint(loops) {
  const rings = loops.map(D.flattenLoop);
  const ys = rings[0].map((p) => p[1]); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  let best = null;
  for (const fr of [0.5, 0.31, 0.69, 0.17, 0.83]) {
    const y = y0 + (y1 - y0) * fr + 0.0137;
    const xs = [];
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i]; const [xj, yj] = ring[j]; if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi); }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.w) best = { w: xs[k + 1] - xs[k], p: [(xs[k] + xs[k + 1]) / 2, y] };
  }
  return best;
}
const arcOf = (p, q, b) => {
  const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const r = (chord * (1 + b * b)) / (4 * Math.abs(b));
  const d = (chord * (1 - b * b)) / (4 * b);
  const c = [(p[0] + q[0]) / 2 - ((q[1] - p[1]) / chord) * d, (p[1] + q[1]) / 2 + ((q[0] - p[0]) / chord) * d];
  return { c, r, ap: Math.atan2(p[1] - c[1], p[0] - c[0]), sweep: 4 * Math.atan(b) };
};
/** An arc as a SPLINE: a cubic Bézier per quarter turn (control points, clamped knots); with `fit`, also the points it passes through. */
function SPLINE(layer, p, q, b, G, fit) {
  const { c, r, ap, sweep } = arcOf(p, q, b);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const out = [];
  for (let s = 0; s < n; s++) {
    const a0 = ap + (sweep * s) / n; const a1 = ap + (sweep * (s + 1)) / n;
    const k = (4 / 3) * Math.tan((a1 - a0) / 4);
    const P0 = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)]; const P3 = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
    const ctrl = [P0, [P0[0] - k * r * Math.sin(a0), P0[1] + k * r * Math.cos(a0)], [P3[0] + k * r * Math.sin(a1), P3[1] - k * r * Math.cos(a1)], P3].map(G);
    const fits = [];
    if (fit) { const m = Math.max(2, Math.ceil(Math.abs((a1 - a0) / RAD) / 7.5)); for (let j = 0; j <= m; j++) { const a = a0 + ((a1 - a0) * j) / m; fits.push(G([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])); } }
    out.push(E(0, 'SPLINE', 8, layer, 70, 8, 71, 3, 72, 8, 73, 4, 74, fits.length, ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((kn) => [40, kn]),
      ...ctrl.flatMap(([x, y]) => [10, f(x), 20, f(y), 30, 0]), ...fits.flatMap(([x, y]) => [11, f(x), 21, f(y), 31, 0])));
  }
  return out;
}

/**
 * One loop as entities. geom: lwpoly | openpoly (flag 0, first corner repeated) | polyline12 (R12 POLYLINE/VERTEX)
 * | lines (LINE + ARC) | splineFit | splineCtrl. opts: ocs (a mirrored part's arcs written with extrusion 0,0,-1),
 * tab (a micro-joint: a gap of this many mm left in the first long straight edge), sloppy (the first line stops this short).
 */
function loopEnts(loop, geom, layer, G, u, opts = {}) {
  if (loop.circle) return [CIRCLE(layer, G(loop.circle), loop.circle[2] * u)];
  const v = loop.v; const n = v.length;
  const gv = v.map(([x, y, b]) => [...G([x, y]), b]);
  if (geom === 'lwpoly') return [LWPOLY(layer, gv)];
  if (geom === 'openpoly') return [LWPOLY(layer, [...gv, [gv[0][0], gv[0][1], 0]], false)];
  if (geom === 'polyline12') return [POLY12(layer, gv)];
  const out = [];
  let tabbed = false; let slopped = false;
  for (let k = 0; k < n; k++) {
    const p = v[k]; const q = v[(k + 1) % n]; const b = p[2] ?? 0;
    if (!b) {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const at = (s) => [p[0] + ((q[0] - p[0]) * s) / len, p[1] + ((q[1] - p[1]) * s) / len];
      if (opts.tab && !tabbed && len > 60) { tabbed = true; out.push(LINE(layer, G(p), G(at(len / 2 - opts.tab / 2))), LINE(layer, G(at(len / 2 + opts.tab / 2)), G(q))); continue; }
      if (opts.sloppy && !slopped && len > 60) { slopped = true; out.push(LINE(layer, G(p), G(at(len - opts.sloppy)))); continue; }
      out.push(LINE(layer, G(p), G(q), opts.color ? [62, opts.color] : []));
      continue;
    }
    if (geom === 'splineFit' || geom === 'splineCtrl') { out.push(...SPLINE(layer, p, q, b, G, geom === 'splineFit')); continue; }
    const { c, r, ap, sweep } = arcOf(p, q, b);
    let a0 = (b > 0 ? ap : ap + sweep) / RAD; let a1 = (b > 0 ? ap + sweep : ap) / RAD;
    const gc = G(c);
    if (opts.ocs) { [a0, a1] = [180 - a1, 180 - a0]; out.push(E(0, 'ARC', 8, layer, 10, f(-gc[0]), 20, f(gc[1]), 40, f(r * u), 50, f(a0), 51, f(a1), 210, 0, 220, 0, 230, -1)); } else out.push(E(0, 'ARC', 8, layer, 10, f(gc[0]), 20, f(gc[1]), 40, f(r * u), 50, f(a0), 51, f(a1)));
  }
  return out;
}

/**
 * The entities of one plate: the plate, every part, its label.
 * o: geom, plate ('lwpoly' | 'lines' | 'polyline12' | null), plateLayer, partLayer, labelLayer, labels ('text' | 'plaintext' | 'mtext' | 'none'),
 *    labelMode ('code' | 'mark' | 'cust' | 'none'), units ('mm' | 'in'), origin.
 * A part may override: geom, label (a string, a list of strings, or null), lm (label mode), and loopEnts' opts.
 */
function nestEnts(plate, parts, o0 = {}) {
  const o = { geom: 'lwpoly', plate: 'lwpoly', plateLayer: 'PLATE', partLayer: 'PARTS', labelLayer: 'LABELS', labels: 'text', labelMode: 'code', units: 'mm', origin: [0, 0], ...o0 };
  const u = o.units === 'in' ? 1 / 25.4 : 1;
  const G = (p) => [(p[0] + o.origin[0]) * u, (p[1] + o.origin[1]) * u];
  const out = [];
  const corners = [[0, 0], [plate.length, 0], [plate.length, plate.width], [0, plate.width]];
  if (o.plate === 'lwpoly') out.push(LWPOLY(o.plateLayer, corners.map(G)));
  if (o.plate === 'polyline12') out.push(POLY12(o.plateLayer, corners.map(G)));
  if (o.plate === 'lines') corners.forEach((p, i) => out.push(LINE(o.plateLayer, G(p), G(corners[(i + 1) % 4]))));
  for (const part of parts) {
    const loops = placedLoops(part.shape, part);
    for (const l of loops) out.push(...loopEnts(l, part.geom ?? o.geom, part.layer ?? o.partLayer, G, u, { ...part, ocs: part.ocs && part.mirrored }));
    const words = labelsOf(part, o.labelMode);
    if (!words.length || o.labels === 'none') continue;
    const lp = labelPoint(loops);
    const h = Math.max(5, Math.min(40, lp.w / (words[0].length + 2)));
    words.forEach((s, i) => {
      const p = G([lp.p[0], lp.p[1] - i * 1.6 * h]);
      if (o.labels === 'mtext') out.push(MTEXT(o.labelLayer, p, h * u, `{\\fArial|b0|i0|c0|p34;\\H1.2x;${s}}`));
      else out.push(TEXT(o.labelLayer, p, h * u, s, { centred: o.labels !== 'plaintext' }));
    });
  }
  return out;
}
function labelsOf(part, mode) {
  if (part.label !== undefined) return part.label == null ? [] : [].concat(part.label);
  const m = part.lm ?? mode;
  if (!part.key || m === 'none') return [];
  return [m === 'mark' ? mark(part.key) : m === 'cust' ? PARTS[part.key].cust : code(part.key)];
}

/** One part: P('COPE', x, y, rotationDeg, mirrored, { …overrides }). */
const P = (key, x = 0, y = 0, rotationDeg = 0, mirrored = false, over = {}) => ({ key, shape: PARTS[key].shape, x, y, rotationDeg, mirrored, ...over });
/** Parts laid in rows on a plate: items [[key, rotationDeg?, mirrored?, overrides?]]. */
const shelf = (items, plate, opts) => D.shelfLayout(items.map(([key, rot = 0, mir = false, over = {}]) => P(key, 0, 0, rot, mir, over)), plate, opts);
/** The nine parts most files nest: every true shape and three rectangles, no twins. */
const MIX = [['COPE'], ['COPE', 90], ['HOLES'], ['TRAP'], ['TRAP', 180], ['ELL'], ['R1'], ['R2'], ['R3']];
const mix = (opts) => shelf(MIX, PS, opts);

/* ───────────────────────────── what a file should give ───────────────────────────── */

/** How a part should be matched: label when it is labelled with a code we know; else its shape / size; the twins by the quantity still needed. */
function ruleOf(part, mode) {
  const m = part.rule ?? (part.label !== undefined ? part.lm : null) ?? part.lm ?? mode;
  if (['label', 'shape', 'size', 'steel', 'ambiguous', 'choice', 'quantity'].includes(m)) return m;
  if (m === 'code' || m === 'mark') return 'label';
  if (TWINS.has(part.key)) return 'quantity';      // identical cut pieces, no label: shared out by what the line still needs (2026-10-13)
  if (STEEL_TWINS.has(part.key)) return 'steel';
  return PARTS[part.key].drawn ? 'shape' : 'size';
}
function expectOf(parts, mode, over = {}) {
  const by = {}; let amb = 0;
  for (const p of parts) { if (!p.key) continue; const r = ruleOf(p, mode); if (r === 'ambiguous') amb += 1; else by[r] = (by[r] ?? 0) + 1; }
  return { status: amb ? 'error' : 'ok', plateBy: 'size', parts: parts.length, placed: parts.length - amb, by, errors: amb ? { PART_AMBIGUOUS: amb } : {}, warnings: [], ...over };
}

/* ───────────────────────────── the cases ───────────────────────────── */

const cases = [];
/**
 * add(group, filename, { what, seen, text | buffer, parts?, plate?, expect, plateCode?, choices?, more?: [{ filename, text }], devCheck? })
 * `parts` + `plate` let the run check that every matched part is stored where the file drew it.
 */
const add = (group, filename, c) => { cases.push({ group, filename, ...c }); };
const GROUPS = {
  'a-own-cnc-export': 'a. Our own CNC export of an automatic nest (parts labelled with our cut-piece codes, plate drawn)',
  'b-customer-marks': 'b. Parts labelled with something that is not our cut-piece code',
  'c-no-labels': 'c. No labels at all',
  'd-plate-not-drawn': 'd. The plate border is not drawn',
  'e-rotated-mirrored': 'e. Parts at arbitrary angles, some mirrored',
  'f-common-cut': 'f. Parts sharing an edge; blocks of equal parts cut edge to edge',
  'g-units': 'g. Drawing units',
  'h-entities-layers': 'h. How outlines, labels and layers are written; things in the file that are not parts',
  'i-errors': 'i. Files that must be refused or warned about',
  'j-identical-shapes': 'j. Two different cut pieces of the identical shape, no label',
  'k-real-programs': 'k. What real nesting programs and drawing offices add',
};

function defineCases() {
  const N12 = (n) => `N${pad2(n)}_12mm_E350_3000x1500.dxf`;

  /* ---- b ---- */
  let parts = mix();
  add('b-customer-marks', N12(11), { what: 'Nine parts, each labelled with the CUSTOMER\'S mark (PM-201 …), which is none of our codes. Only shape and size can match.', seen: 'any customer who nests by their own part numbers', parts, plate: PS, text: doc(nestEnts(PS, parts, { labelMode: 'cust' })), expect: expectOf(parts, 'cust') });
  add('b-customer-marks', N12(12), { what: 'The same nest labelled with the DRAWING MARK of each part (NRF-MK-1xx) — a name we do hold, on the part row.', seen: 'customer nests by drawing mark', parts, plate: PS, text: doc(nestEnts(PS, parts, { labelMode: 'mark' })), expect: expectOf(parts, 'mark') });
  parts = shelf([['COPE', 0, false, { label: `${PARTS.COPE.cust} / ${code('COPE')} QTY 4`, lm: 'code' }], ['HOLES', 0, false, { label: code('HOLES').toLowerCase().replaceAll('-', ' '), lm: 'code' }], ['T1', 90, false, { label: `PART: ${code('T1')} (1 OFF)`, lm: 'code' }], ['T2', 90, false, { label: [`ITEM 6`, code('T2')], lm: 'code' }], ['X1', 0, false, { label: `${code('X1')};12THK`, lm: 'code' }], ['X2', 0, false, { label: `[${code('X2')}]`, lm: 'code' }]], PS);
  add('b-customer-marks', N12(13), { what: 'Our code inside a longer label: "PM-201 / NRF-CP-01 QTY 4", lower case with spaces for dashes, "PART: … (1 OFF)", two lines of text, "code;12THK", "[code]". The identical-shape pieces are told apart by these labels.', seen: 'part names typed by hand in any nesting program', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });
  parts = shelf([['T1', 90, false, { label: `${code('T1')}_12THK_1NOS`, lm: 'code' }], ['T2', 90, false, { label: `${code('T2')}_12THK_1NOS`, lm: 'code' }], ['X1', 0, false, { label: `${code('X1')}_12MM_E350`, lm: 'code' }], ['X2', 0, false, { label: `${code('X2')}_12MM_E350`, lm: 'code' }], ['R1', 0, false, { label: `${code('R1')}_12THK_5NOS`, lm: 'code' }]], PS);
  add('b-customer-marks', N12(14), { what: 'Part names that are FILE NAMES: our code with _12THK_1NOS / _12MM_E350 joined on by underscores. The identical-shape pieces can only be told apart if the code is read out of the name.', seen: 'ProNest, SigmaNEST, Lantek: a part is named after the CAD file it was imported from', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });

  /* ---- c ---- */
  parts = mix();
  add('c-no-labels', 'nest_0007.dxf', { what: 'Nine parts and the plate, no text of any kind, everything on layer 0. The file name says nothing either.', seen: 'Deepnest, SVGnest, NestFab geometry-only export', parts, plate: PS, text: doc(nestEnts(PS, parts, { labels: 'none', plateLayer: '0', partLayer: '0' })), expect: expectOf(parts, 'none') });

  /* ---- d ---- */
  parts = mix();
  add('d-plate-not-drawn', 'N3_12mm_E350_3000x1500.dxf', { what: 'No plate border; the plate size, thickness and grade are only in the file name.', seen: 'part-only exports; SheetCam-style job files', parts, plate: PS, noPlate: true, text: doc(nestEnts(PS, parts, { plate: null })), expect: expectOf(parts, 'code') });
  add('d-plate-not-drawn', 'NEST-7.dxf', { what: 'No plate border and nothing anywhere that says the plate size. Must ask which plate (plateCode), not guess.', seen: 'part-only exports', parts, plate: PS, noPlate: true, text: doc(nestEnts(PS, parts, { plate: null })), expect: expectOf(parts, 'code', { status: 'error', plateBy: null, errors: { PLATE_NOT_DRAWN: 1 } }) });
  add('d-plate-not-drawn', 'NEST-8.dxf', { what: 'The same file, with the plate named in the request (plateCode).', seen: 'the upload screen after the user picks the plate', parts, plate: PS, noPlate: true, plateCode: PLATES.P12S.code, text: doc(nestEnts(PS, parts, { plate: null })), expect: expectOf(parts, 'code', { plateBy: 'code' }) });
  add('d-plate-not-drawn', 'NEST-9.dxf', { what: 'No plate border; a title line in the file says "PL 12 x 3000 x 1500 E350".', seen: 'hand-made AutoCAD nests', parts, plate: PS, noPlate: true, text: doc([...nestEnts(PS, parts, { plate: null }), TEXT('TITLE', [0, -200], 60, 'PL 12 x 3000 x 1500 E350', { centred: false })]), expect: expectOf(parts, 'code') });

  /* ---- e ---- */
  const turned = [['COPE', 17], ['COPE', 197, true], ['TRAP', 33.5], ['TRAP', 301, true], ['ELL', 45], ['ELL', 111, true], ['HOLES', 7.25], ['R1', 12], ['R3', 63], ['T1', 28.4]];
  const mirrorCheck = (want) => (e) => { const got = e.placements.filter((p) => p.mirrored).length; return got === want ? [] : [`${got} placements say mirrored, ${want} were drawn mirrored`]; };
  parts = shelf(turned, PA, { gap: 40 });
  add('e-rotated-mirrored', 'N21_12mm_E350_6000x2500.dxf', { what: 'Ten parts at free angles (17°, 33.5°, 301° …), three of them mirrored, labelled with our codes.', seen: 'every true-shape nesting program', parts, plate: PA, text: doc(nestEnts(PA, parts)), expect: expectOf(parts, 'code', { check: mirrorCheck(3) }) });
  parts = shelf(turned.filter(([k]) => k !== 'T1'), PA, { gap: 40 });
  add('e-rotated-mirrored', 'N22_12mm_E350_6000x2500.dxf', { what: 'The same angles and mirrors with NO labels: the angle and the hand must come from the shape alone.', seen: 'Deepnest; any program with labels switched off', parts, plate: PA, text: doc(nestEnts(PA, parts, { labels: 'none' })), expect: expectOf(parts, 'none', { check: mirrorCheck(3) }) });
  parts = shelf([['COPE', 0, true, { ocs: true }], ['COPE', 90, true, { ocs: true }], ['COPE', 215, true, { ocs: true }], ['COPE', 40]], PS, { gap: 40 });
  add('e-rotated-mirrored', N12(23), { what: 'Mirrored parts as AutoCAD writes them after MIRROR: LINE + ARC, the arcs with extrusion (0,0,-1), so their centre and angles are in the flipped coordinate system.', seen: 'AutoCAD and anything built on it', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'lines' })), expect: expectOf(parts, 'code', { check: mirrorCheck(3) }) });

  /* ---- f ---- */
  parts = [P('R1', 20, 20), P('R1', 1220, 20), P('R2', 20, 420), P('R2', 820, 420), P('R2', 1620, 420), P('COPE', 20, 700)];
  add('f-common-cut', N12(31), { what: 'Parts that touch along a whole edge, each still its own closed polyline (the shared edge is drawn twice).', seen: 'programs that apply common-line cutting only in the NC code', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });
  parts = [P('R1', 20, 20), P('R1', 1220, 20), P('R2', 20, 420), P('R2', 820, 420), P('COPE', 20, 700)].map((p) => ({ ...p, label: code(p.key) }));
  add('f-common-cut', N12(32), { what: 'A common-cut nest as loose LINEs: every shared cut is drawn ONCE, collinear cuts as one long line.', seen: 'SigmaNEST / Lantek / ProNest common-line cutting exported as geometry', parts, plate: PS, text: D.makeNestDxf({ plate: PS, parts, style: 'commoncut' }), expect: expectOf(parts, 'code') });
  parts = [...D.gridParts({ shape: PARTS.R2.shape, cols: 3, rows: 2, x: 100, y: 100, label: code('R2') }).map((p) => ({ ...p, key: 'R2' })), { ...P('R1', 100, 800), label: code('R1') }];
  add('f-common-cut', N12(33), { what: 'A block of 3 × 2 equal parts cut edge to edge: a rim and long cuts right across it that CROSS with no end at the crossing.', seen: 'grid / array nesting of equal rectangles in any program', parts, plate: PS, text: D.makeNestDxf({ plate: PS, parts, style: 'commoncut-grid' }), expect: expectOf(parts, 'code') });
  parts = [...D.gridParts({ shape: PARTS.R2.shape, cols: 3, rows: 2, x: 0, y: 0, label: code('R2') }).map((p) => ({ ...p, key: 'R2' })), { ...P('R1', 1000, 800), label: code('R1') }];
  add('f-common-cut', N12(34), { what: 'The same block set into the plate\'s corner, so the plate\'s own edge is two sides of the block. The rest of the plate is its remainder, not a part; the parts on the very edge deserve a warning (no kerf of clearance), not a refusal.', seen: 'strip / shear-style nests', parts, plate: PS, text: D.makeNestDxf({ plate: PS, parts, style: 'commoncut-grid' }), expect: expectOf(parts, 'code', { status: 'warning', warnings: ['IN_RIM'] }) });

  /* ---- g ---- */
  parts = mix();
  add('g-units', 'N41_12mm_E350_3000x1500.dxf', { what: 'Drawn in INCHES, and the header says so ($INSUNITS = 1).', seen: 'ProNest, SigmaNEST and others set to imperial', parts, plate: PS, text: doc(nestEnts(PS, parts, { units: 'in' }), { insunits: 1 }), expect: expectOf(parts, 'code', { check: (e) => (e.units === 'in' ? [] : [`units read as ${e.units}`]) }) });
  add('g-units', 'N42_12mm_E350_3000x1500.dxf', { what: 'No HEADER section at all (ENTITIES only), drawn in mm.', seen: 'minimal R12 writers: CAM programs, Deepnest converters, many in-house tools', parts, plate: PS, text: doc(nestEnts(PS, parts), { header: 'none' }), expect: expectOf(parts, 'code') });
  add('g-units', 'N43_12mm_E350_3000x1500.dxf', { what: 'No units in the header, but DRAWN IN INCHES (the plate is 118.11 × 59.06). Nothing matches as millimetres and every part is a cut piece at × 25.4: it must be read as inches, and a note must say so.', seen: 'imperial programs writing R12; $INSUNITS = 0 is very common', parts, plate: PS, text: doc(nestEnts(PS, parts, { units: 'in' }), { header: 'r12' }),
    expect: expectOf(parts, 'code', { check: (e) => [...(e.units === 'in' ? [] : [`units read as ${e.units}`]), ...(e.notes.some((x) => /read as drawn in inches/i.test(x)) ? [] : ['no note says the file was read as inches'])] }) });
  add('g-units', 'nest_0044.dxf', { what: 'The same with NO labels and a file name that says nothing: only the parts themselves can show the file is in inches.', seen: 'Deepnest / SVGnest conversions from an imperial drawing', parts, plate: PS, text: doc(nestEnts(PS, parts, { units: 'in', labels: 'none' }), { header: 'r12' }),
    expect: expectOf(parts, 'none', { check: (e) => (e.units === 'in' && e.notes.some((x) => /read as drawn in inches/i.test(x)) ? [] : ['not read as inches, or no note says so']) }) });

  /* ---- h ---- */
  const hParts = () => shelf([['COPE'], ['COPE', 90], ['HOLES'], ['TRAP'], ['ELL'], ['R1'], ['T1', 90]], PS);
  parts = hParts();
  add('h-entities-layers', N12(51), { what: 'Outlines as closed LWPOLYLINEs with bulges (the cope\'s arc), holes as CIRCLEs, labels as TEXT; layers PLATE / PARTS / LABELS.', seen: 'the commonest modern export', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(52), { what: 'Outlines as separate LINE and ARC entities that only close together; the plate as four LINEs; everything on layer 0; plain (not centred) TEXT.', seen: 'R12-style exports; exploded AutoCAD drawings', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'lines', plate: 'lines', plateLayer: '0', partLayer: '0', labelLayer: '0', labels: 'plaintext' })), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(53), { what: 'The cope\'s arc written as a SPLINE that carries FIT POINTS (the points the curve passes through).', seen: 'AutoCAD splines drawn by fit; Inkscape / Deepnest conversions', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'splineFit' })), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(54), { what: 'The same arc as a SPLINE with CONTROL POINTS ONLY (a cubic Bézier: degree 3, clamped knots) — how most programs write a spline.', seen: 'Rhino, SolidWorks, Inventor, Illustrator / Inkscape, Deepnest', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'splineCtrl' })), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(55), { what: 'DXF R12 as old programs write it: POLYLINE / VERTEX / SEQEND with bulges, group codes padded with spaces, LF line ends, $ACADVER AC1009 and no units.', seen: 'R12 exports of SigmaNEST, ProNest, Lantek; our own CNC export is R12', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'polyline12', plate: 'polyline12' }), { header: 'r12', eol: '\n', pad: true }), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(56), { what: 'LWPOLYLINEs NOT flagged closed, the first corner repeated at the end.', seen: 'very common from CAD exports and converters', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'openpoly' })), expect: expectOf(parts, 'code') });
  add('h-entities-layers', N12(57), { what: 'Labels as MTEXT with formatting codes ({\\fArial|b0…;\\H1.2x;CODE}); plate on layer SHEET, parts on layer CUT.', seen: 'AutoCAD-based nests', parts, plate: PS, text: doc(nestEnts(PS, parts, { labels: 'mtext', plateLayer: 'SHEET', partLayer: 'CUT' })), expect: expectOf(parts, 'code') });
  parts = hParts().map((p) => ({ ...p, label: code(p.key) }));
  add('h-entities-layers', N12(58), { what: 'Every part an INSERT of a BLOCK named by our code (rotation in the INSERT), no text.', seen: 'SigmaNEST, AVEVA, OptiNest "parts as blocks" — the block is named after the part', parts, plate: PS, text: D.makeNestDxf({ plate: PS, parts, style: 'blocks' }), expect: expectOf(parts, 'code') });
  {
    // Blocks with a generic name; the code is an ATTRIB on the INSERT.
    const generic = hParts().map((p, i) => ({ ...p, label: `PART_${i + 1}` }));
    const sp = splitEntities(D.makeNestDxf({ plate: PS, parts: generic, style: 'blocks' }));
    let i = 0;
    sp.ents = sp.ents.flatMap((ent) => {
      if (ent[1].trim() !== 'INSERT') return [ent];
      const part = generic[i++];
      const lp = labelPoint(placedLoops(part.shape, part));
      return [[...ent, '66', '1'], E(0, 'ATTRIB', 8, 'PART', 10, f(lp.p[0]), 20, f(lp.p[1]), 40, 20, 1, code(part.key), 2, 'PARTNAME', 70, 0), E(0, 'SEQEND', 8, 'PART')];
    });
    add('h-entities-layers', N12(59), { what: 'Blocks with generic names (PART_1 …); our code is an ATTRIB (attribute) on each INSERT.', seen: 'block libraries with attributes: AutoCAD nests, some Lantek / SigmaNEST setups', parts: hParts(), plate: PS, text: joinEntities(sp), expect: expectOf(hParts(), 'code') });
  }
  parts = hParts().map((p) => ({ ...p, label: code(p.key) }));
  {
    const base = D.makeNestDxf({ plate: PS, parts, style: 'noisy', options: { leadIns: false, title: ['PL 12 x 3000 x 1500 E350', 'NEST NO: N60', 'DATE 10-10-2026', 'SCALE 1:20'] } });
    const sp = splitEntities(base);
    const ox = 1234.5; const oy = -678.9;
    sp.ents.push(E(0, 'DIMENSION', 8, 'DIM', 2, '*D1', 10, f(ox), 20, f(oy + 1700), 11, f(ox + 1500), 21, f(oy + 1720), 70, 32, 1, '<>', 13, f(ox), 23, f(oy + 1500), 14, f(ox + 3000), 24, f(oy + 1500)),
      E(0, 'LEADER', 8, 'DIM', 71, 1, 72, 0, 73, 0, 76, 3, 10, f(ox + 300), 20, f(oy + 150), 10, f(ox - 150), 20, f(oy + 400), 10, f(ox - 250), 20, f(oy + 400)),
      MTEXT('NOTES', [ox - 280, oy + 430], 30, 'SEE NOTE 3\\PGRIND EDGES'));
    add('h-entities-layers', 'N60.dxf', { what: 'A drawing sheet round the nest: border (layer BORDER), title block text "PL 12 x 3000 x 1500 E350" / "NEST NO: N60" (layer TITLE), a DIMENSION, a LEADER with an MTEXT note, labels as mixed TEXT / MTEXT, the origin away from 0,0.', seen: 'nests issued as drawings: AutoCAD, Tekla / Inventor nesting sheets', parts, plate: PS, text: joinEntities(sp), expect: expectOf(parts, 'code') });
    // The same sheet with every entity on layer 0.
    const flat = splitEntities(base);
    for (const ent of flat.ents) for (let k = 0; k < ent.length; k += 2) if (String(ent[k]).trim() === '8') ent[k + 1] = '0';
    add('h-entities-layers', 'N61.dxf', { what: 'The same sheet with EVERYTHING on layer 0: the border is just a bigger rectangle round the plate.', seen: 'hand-made AutoCAD nests; any export with layers flattened', parts, plate: PS, text: joinEntities(flat), expect: expectOf(parts, 'code') });
  }
  {
    parts = shelf([['COPE'], ['HOLES'], ['R1'], ['R2']], PS);
    const dims = [];
    const r1 = parts.find((p) => p.key === 'R1');
    // A dimension over R1, exploded: two extension lines, the dimension line, its number; and the gap to the next part, "25 mm".
    dims.push(LINE('0', [r1.x, r1.y + 402], [r1.x, r1.y + 470]), LINE('0', [r1.x + 1200, r1.y + 402], [r1.x + 1200, r1.y + 470]), LINE('0', [r1.x, r1.y + 460], [r1.x + 1200, r1.y + 460]),
      TEXT('0', [r1.x + 600, r1.y + 480], 30, '1200'), TEXT('0', [r1.x + 1212, r1.y + 480], 20, '25 mm'), TEXT('0', [1500, 1530], 40, '3000'), LINE('0', [0, 1520], [3000, 1520]));
    add('h-entities-layers', N12(62), { what: 'Dimensions EXPLODED onto layer 0 beside the plate layer and the part layer: loose extension and dimension lines, the numbers as TEXT — "1200", "3000", and a gap dimension "25 mm".', seen: 'dimensioned nests saved to R12 (dimensions become lines and text)', parts, plate: PS, text: doc([...nestEnts(PS, parts), ...dims]), expect: expectOf(parts, 'code') });
  }

  /* ---- i ---- */
  const bad = (errors, over = {}) => ({ status: 'error', errors, ...over });
  parts = [P('R1', 100, 100), P('R1', 700, 300)];
  add('i-errors', N12(71), { what: 'Two parts overlapping.', seen: 'a nest edited by hand', text: doc(nestEnts(PS, parts)), expect: bad({ OVERLAP: 1 }, { plateBy: 'size', parts: 2 }) });
  parts = [P('R1', 100, 100), P('R1', 2400, 600)];
  add('i-errors', N12(72), { what: 'A part lying across the plate\'s edge (600 mm off it).', seen: 'a nest made for a longer plate', text: doc(nestEnts(PS, parts)), expect: bad({ OUTSIDE_PLATE: 1 }, { plateBy: 'size', parts: 2, placed: 1 }) });
  parts = [P('R1', 100, 100), P('K1', 100, 600)];
  add('i-errors', N12(73), { what: 'A 20 mm cut piece (NRF-CP-13) nested on a 12 mm plate.', seen: 'the wrong part list loaded for a plate', text: doc(nestEnts(PS, parts)), expect: bad({ PART_WRONG_THICKNESS: 1 }, { plateBy: 'size', parts: 2 }) });
  parts = [P('R1', 100, 100), P('B1', 100, 600)];
  add('i-errors', N12(74), { what: 'An E250 cut piece (NRF-CP-12) nested on an E350 plate.', seen: 'grades mixed on one plate', text: doc(nestEnts(PS, parts)), expect: bad({ PART_WRONG_GRADE: 1 }, { plateBy: 'size', parts: 2 }) });
  parts = [P('R1', 100, 100), { key: null, shape: rectShape(333, 222), x: 100, y: 600, rotationDeg: 0, mirrored: false, label: 'ZZ-9' }];
  add('i-errors', N12(75), { what: 'A part the line does not have (333 × 222, labelled ZZ-9).', seen: 'another order\'s part on the plate (filler parts)', text: doc(nestEnts(PS, parts)), expect: bad({ PART_UNKNOWN: 1 }, { plateBy: 'size', parts: 2, placed: 1 }) });
  parts = shelf([['HOLES'], ['HOLES'], ['HOLES'], ['R1']], PS);
  add('i-errors', N12(76), { what: 'More pieces than the line needs: three of NRF-CP-02 where the line needs two. A warning that names the surplus and needs "save anyway" — not a silent save.', seen: 'filler / spare parts added by the nester', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code', { req: ['OVER_COVERAGE'] }) });
  parts = shelf([['COPE'], ['R1']], PS);
  { const text = doc(nestEnts(PS, parts)); add('i-errors', N12(77), { what: 'The same file twice in one upload (the second copy is "N77_… (1).dxf"). The first is read; the second is refused as the same plate uploaded twice.', seen: 'a browser download folder', text, more: [{ filename: 'N77_12mm_E350_3000x1500 (1).dxf', text }], expect: expectOf(parts, 'code'), expectMore: [bad({ DUPLICATE_FILE: 1 })] }); }
  { const b = Buffer.alloc(2048); b.write('AC1032', 0, 'latin1'); for (let i = 12; i < b.length; i += 1) b[i] = (i * 37 + 11) % 251; b[6] = 0; b[7] = 0;
    add('i-errors', 'N78_renamed_dwg.dxf', { what: 'A DWG (binary AutoCAD drawing) renamed to .dxf.', seen: 'the commonest wrong file of all', buffer: b, expect: bad({ BAD_FILE: 1 }, { check: (e) => (/DWG/.test(e.errors[0]?.message ?? '') ? [] : ['the message does not say it is a DWG']) }) }); }
  add('i-errors', 'N79_empty.dxf', { what: 'An empty file (0 bytes).', seen: 'a failed export or download', buffer: Buffer.alloc(0), expect: bad({ BAD_FILE: 1 }) });
  add('i-errors', 'N80_no_entities.dxf', { what: 'A valid DXF with a header and an empty ENTITIES section.', seen: 'an export with every layer switched off', text: doc([]), expect: bad({ EMPTY_NEST: 1 }) });
  { const b = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1'), Buffer.from([0, 0x53, 0x45, 0x43, 0x54, 0x49, 0x4f, 0x4e, 0, 2, 0x48, 0x45, 0x41, 0x44, 0x45, 0x52, 0])]);
    add('i-errors', 'N81_binary.dxf', { what: 'A BINARY DXF.', seen: 'AutoCAD "DXF binary" save option', buffer: b, expect: bad({ BAD_FILE: 1 }, { check: (e) => (/binary/i.test(e.errors[0]?.message ?? '') ? [] : ['the message does not say it is a binary DXF']) }) }); }
  parts = [P('R1', 100, 100), { ...P('R2', 100, 600), label: code('R1') }];
  add('i-errors', N12(82), { what: 'A part labelled with one cut piece\'s code but drawn as another\'s shape.', seen: 'a label left behind after a part was swapped', text: doc(nestEnts(PS, parts)), expect: bad({ PART_LABEL_MISMATCH: 1 }, { plateBy: 'size', parts: 2 }) });
  parts = [P('R3', 100, 100), P('R3', 401.5, 100), P('R1', 100, 600)];
  add('i-errors', N12(83), { what: 'Two parts 1.5 mm apart — nearer than our 3 mm kerf. A warning that needs "save anyway", because the customer may cut with another kerf.', seen: 'laser nests brought to a plasma shop', text: doc(nestEnts(PS, parts)), expect: { status: 'warning', plateBy: 'size', parts: 3, placed: 3, errors: {}, warnings: ['TOO_CLOSE'] } });
  parts = [P('R1', 100, 100)];
  add('i-errors', 'N84_12mm_E350_2750x1300.dxf', { what: 'A plate size the catalog does not have (2750 × 1300).', seen: 'a remnant or a mill size not yet in the catalog', text: doc(nestEnts({ length: 2750, width: 1300 }, parts)), expect: bad({ PLATE_NOT_FOUND: 1 }, { plateBy: null, parts: 1 }) });
  add('i-errors', N12(85), { what: 'A plate with nothing on it.', seen: 'an empty sheet of a multi-sheet job', text: doc(nestEnts(PS, [])), expect: bad({ EMPTY_NEST: 1 }) });
  add('i-errors', 'N86_program.dxf', { what: 'Not a drawing at all: the NC program (G-code) of the nest, renamed to .dxf.', seen: 'the wrong one of the two files a nesting program writes', text: '%\r\nO1001 (NEST 86 12MM E350)\r\nG21 G90\r\nG00 X20. Y20.\r\nM07\r\nG01 X620. Y20.\r\nG01 X620. Y320.\r\nM08\r\nM30\r\n%\r\n', expect: bad({ BAD_FILE: 1 }) });

  parts = shelf([['COPE'], ['R1', 0, false, { tab: 4.2 }], ['R2']], PS);
  add('i-errors', N12(87), { what: 'An outline with a 4.2 mm gap — wider than a micro-joint. It must NOT vanish: the file is refused with where the gap is and how wide.', seen: 'a contour broken by hand; a tab set far too wide', devCheck: false, text: doc(nestEnts(PS, parts, { geom: 'lines' })), expect: { status: 'error', plateBy: 'size', parts: 2, placed: 2, errors: { OPEN_CONTOUR: 1 }, check: (e) => (/4\.2 mm apart at \(/.test(e.errors[0]?.message ?? '') ? [] : ['the message does not say how wide the gap is and where']) } });
  {
    parts = shelf([['COPE'], ['R2']], PS);
    const x = 100; const y = 900;
    const u = [LINE('PARTS', [x, y + 400], [x, y]), LINE('PARTS', [x, y], [x + 1200, y]), LINE('PARTS', [x + 1200, y], [x + 1200, y + 400])];
    add('i-errors', N12(88), { what: 'Three sides of a 1200 × 400 part; the fourth side was never drawn. Not an outline with a small gap, but it could have been a part: a warning that needs "save anyway", never only a note.', seen: 'a line deleted by accident; a part clipped by a layer filter', devCheck: false, text: doc([...nestEnts(PS, parts), ...u]), expect: { status: 'warning', plateBy: 'size', parts: 2, placed: 2, errors: {}, warnings: ['SHAPE_IGNORED'] } });
    const out = [LWPOLY('PARTS', [[3200, 100], [4000, 100], [4000, 300], [3200, 300]]), TEXT('LABELS', [3600, 200], 30, code('R2'))];
    add('i-errors', N12(89), { what: 'One of the line\'s cut pieces drawn OUTSIDE the plate (parked beside it). It is not nested; the warning must name it.', seen: 'parts left in the "unplaced" area of the nesting program', devCheck: false, text: doc([...nestEnts(PS, parts), ...out]), expect: { status: 'warning', plateBy: 'size', parts: 2, placed: 2, errors: {}, warnings: ['SHAPE_IGNORED'], check: (e) => (e.warnings[0]?.message.includes(code('R2')) ? [] : ['the warning does not name the cut piece drawn outside the plate']) } });
    const hatch = [E(0, 'HATCH', 8, 'PARTS', 10, 0, 20, 0, 30, 0, 2, 'SOLID', 70, 1, 71, 0, 91, 1, 92, 1, 93, 4, 72, 1, 10, 1500, 20, 900, 11, 2300, 21, 900, 72, 1, 10, 2300, 20, 900, 11, 2300, 21, 1100, 72, 1, 10, 2300, 20, 1100, 11, 1500, 21, 1100, 72, 1, 10, 1500, 20, 1100, 11, 1500, 21, 900, 75, 0, 76, 1, 98, 0)];
    add('i-errors', N12(90), { what: 'A part drawn only as a HATCH (a filled area), which the reader does not read. A warning must say a filled area was not read — a part may be missing.', seen: 'parts exported as fills: Illustrator / Inkscape / some laser front-ends', devCheck: false, text: doc([...nestEnts(PS, parts), ...hatch]), expect: { status: 'warning', plateBy: 'size', parts: 2, placed: 2, errors: {}, warnings: ['SHAPE_IGNORED'] } });
  }

  /* ---- j ---- */
  parts = shelf([['T1', 90], ['T2', 90], ['X1'], ['X2'], ['COPE'], ['R1']], PS);
  add('j-identical-shapes', N12(91), { what: 'The two sniped stiffeners (NRF-CP-05 / -06: the same drawing) and the two 350 × 250 rectangles (NRF-CP-10 / -11), with no label. Identical shape, thickness and grade: each pair is the same steel whichever is called which, so they are SHARED OUT by the quantity the line still needs (one each), each saying what else it could have been, with a note.', seen: 'handed parts, repeated details, spans of a bridge', parts, plate: PS, text: doc(nestEnts(PS, parts, { labels: 'none' })),
    expect: expectOf(parts, 'none', { check: (e) => { const a = e.placements.filter((x) => x.by === 'quantity'); return [...(a.length === 4 && a.every((x) => x.alternatives?.length === 1) ? [] : ['a shared-out part does not carry the one other cut piece it could have been']), ...(new Set(a.map((x) => x.cutPlateId)).size === 4 ? [] : ['the four parts were not shared one to each cut piece']), ...(e.notes.some((n) => /shared out/.test(n)) ? [] : ['no note says parts were shared out'])]; } }) });
  add('j-identical-shapes', N12(92), { what: 'The same file sent again with the user\'s own choices for the four parts (each swapped to the other cut piece). The user\'s choice wins over the sharing-out.', seen: 'the upload screen after the user picks', parts, plate: PS, text: doc(nestEnts(PS, parts, { labels: 'none' })), choicesFrom: N12(91), expect: { status: 'ok', plateBy: 'size', parts: 6, placed: 6, by: { choice: 4, shape: 1, size: 1 }, errors: {}, warnings: [] } });

  parts = [...shelf([['X1'], ['X1'], ['X1'], ['R1']], PS)].map((p, i) => (i === 2 ? { ...p, rule: 'ambiguous' } : p));
  add('j-identical-shapes', N12(93), { what: 'THREE unlabelled 350 × 250 rectangles where the line needs one of NRF-CP-10 and one of NRF-CP-11. Two are shared out; a third would over-fill, so that one part comes back AMBIGUOUS with its two choices and says why.', seen: 'a spare / filler part added by the nester', devCheck: false, text: doc(nestEnts(PS, parts, { labels: 'none' })),
    expect: expectOf(parts, 'none', { check: (e) => { const a = e.errors.filter((x) => x.code === 'PART_AMBIGUOUS'); return a.length === 1 && a[0].choices?.length === 2 && /needs no more/.test(a[0].message) ? [] : ['the over-full part does not carry its two choices and the reason']; } }) });

  /* ---- k ---- */
  parts = mix().map((p) => ({ ...p, label: code(p.key) }));
  add('k-real-programs', N12(101), { what: 'Lead-ins, pierce points and rapid moves ON THE SAME LAYER as the parts (short lines from the scrap onto each contour, a tiny circle at each pierce, lines hopping from part to part).', seen: 'a nest exported after toolpathing: SigmaNEST, ProNest, Lantek, SheetCam', parts, plate: PS, text: D.makeNestDxf({ plate: PS, parts, style: 'polyline', options: { leadIns: true, leadLayer: 'PART', rapidLayer: 'PART' } }), expect: expectOf(parts, 'code') });
  parts = shelf([['COPE', 0, false, { tab: 1.5 }], ['R1', 0, false, { tab: 1.5 }], ['R2'], ['TRAP', 0, false, { tab: 1.5 }]], PS);
  add('k-real-programs', N12(102), { what: 'MICRO-JOINTS (tabs): three of the four contours have a 1.5 mm gap left uncut so the part stays in the skeleton. The contour is not closed.', seen: 'laser nests: Lantek, TruTops, SigmaNEST, AVEVA ("burning gaps")', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'lines' })), expect: expectOf(parts, 'code') });
  parts = shelf([['COPE', 0, false, { sloppy: 0.3 }], ['R1', 0, false, { sloppy: 0.3 }], ['R2']], PS);
  add('k-real-programs', N12(103), { what: 'Sloppy CAD: on two parts one line stops 0.3 mm short of the corner.', seen: 'hand-drawn nests; parts traced or converted from PDF', parts, plate: PS, text: doc(nestEnts(PS, parts, { geom: 'lines' })), expect: expectOf(parts, 'code') });
  {
    // A bridge: two rectangles 10 mm apart joined by a 3 mm wide neck, so they are ONE contour.
    const x = 100; const y = 100; const L = (p, q) => LINE('PARTS', p, q);
    const bridge = [L([x, y], [x + 800, y]), L([x + 800, y], [x + 800, y + 98.5]), L([x + 800, y + 98.5], [x + 810, y + 98.5]), L([x + 810, y + 98.5], [x + 810, y]), L([x + 810, y], [x + 1610, y]), L([x + 1610, y], [x + 1610, y + 200]), L([x + 1610, y + 200], [x + 810, y + 200]),
      L([x + 810, y + 200], [x + 810, y + 101.5]), L([x + 810, y + 101.5], [x + 800, y + 101.5]), L([x + 800, y + 101.5], [x + 800, y + 200]), L([x + 800, y + 200], [x, y + 200]), L([x, y + 200], [x, y]),
      TEXT('LABELS', [x + 400, y + 100], 30, code('R2')), TEXT('LABELS', [x + 1210, y + 100], 30, code('R2'))];
    parts = [P('R1', 100, 600)];
    add('k-real-programs', N12(104), { what: 'A BRIDGE cut: two parts joined by a 3 mm neck so one pierce cuts both — they are one closed contour in the file. Each half carries its own label.', seen: 'thick-plate plasma / oxy-fuel nests: SigmaNEST, ProNest, AVEVA ("bridges")', devCheck: false, text: doc([...nestEnts(PS, parts), ...bridge]), expect: { status: 'ok', plateBy: 'size', parts: 3, placed: 3, by: { label: 3 }, errors: {}, warnings: [] } });
  }
  {
    // Kerf-compensated: every contour drawn 1.5 mm outside the part (the torch's centre line).
    const grow = (key, x, y) => ({ key, shape: rectShape(PARTS[key].length + 3, PARTS[key].width + 3), x: x - 1.5, y: y - 1.5, rotationDeg: 0, mirrored: false, label: code(key) });
    parts = [grow('R1', 100, 100), grow('R2', 100, 600), grow('R3', 100, 900)];
    add('k-real-programs', N12(105), { what: 'KERF-COMPENSATED contours: each part is drawn 1.5 mm bigger all round (the path of the torch\'s centre, not the part). Labelled with our codes.', seen: 'a toolpath export instead of a geometry export, from any CAM', devCheck: false, text: doc(nestEnts(PS, parts)), expect: { status: 'ok', plateBy: 'size', parts: 3, placed: 3, by: { label: 3 }, errors: {}, warnings: [] } });
  }
  {
    parts = shelf([['R1'], ['COPE'], ['R2']], PS);
    const r1 = parts[0];
    const etch = [LWPOLY('ETCHING', [[r1.x + 100, r1.y + 250], [r1.x + 140, r1.y + 250], [r1.x + 140, r1.y + 320], [r1.x + 100, r1.y + 320]]), LWPOLY('ETCHING', [[r1.x + 160, r1.y + 250], [r1.x + 200, r1.y + 250], [r1.x + 200, r1.y + 320], [r1.x + 160, r1.y + 320]]), LINE('ETCHING', [r1.x + 600, r1.y], [r1.x + 600, r1.y + 400])];
    add('k-real-programs', N12(106), { what: 'MARKING geometry on its own layer, here called ETCHING: the part number scribed as outlines (two closed "0" letters) and a layout line across the part.', seen: 'plasma / powder marking: ProNest (SCRIBE), SigmaNEST, Lantek, AVEVA ("markings") — the layer name is whatever the shop set', parts, plate: PS, devCheck: false, text: doc([...nestEnts(PS, parts), ...etch]), expect: expectOf(parts, 'code', { check: (e) => (e.placements.some((p) => p.shapeFrom === 'nesting file' || p.rings.cutouts.length) ? ['the scribed letters were stored as cut-outs of the part (its outline was "taken from the nesting file")'] : []) }) });
    const etch3 = etch.map((ent) => ent.map((v, k) => (k % 2 === 1 && v === 'ETCHING' ? 'LAYER_3' : v)));
    add('k-real-programs', N12(117), { what: 'The same marking on a layer whose name says nothing (LAYER_3) — numbered and colour-named layers are common.', seen: 'machine-specific layer maps: Lantek, TruTops, Messer / ESAB posts', parts, plate: PS, devCheck: false, text: doc([...nestEnts(PS, parts), ...etch3]), expect: expectOf(parts, 'code', { check: (e) => (e.placements.some((p) => p.shapeFrom === 'nesting file' || p.rings.cutouts.length) ? ['the scribed letters were stored as cut-outs of the part (its outline was "taken from the nesting file")'] : []) }) });
  }
  {
    // Closed marking with NOTHING to say it is marking: no open line beside it. One part has a drawing, one has none.
    parts = shelf([['R1'], ['COPE'], ['R2']], PS);
    const box = (layer, x, y) => LWPOLY(layer, [[x, y], [x + 40, y], [x + 40, y + 70], [x, y + 70]]);
    const r1 = parts[0]; const cope = parts[1];
    const noCut = (e) => (e.placements.some((p) => p.rings.cutouts.length) ? ['a closed shape of another layer was stored as a cut-out'] : []);
    add('k-real-programs', N12(118), { what: 'Closed shapes inside two parts on ANOTHER layer than their outlines (LAYER_3), with no marking line to give them away. On the part that has a drawing, the drawing has no such openings: marking, a note. On the part with no drawing nothing can tell: they are NOT stored as cut-outs, and a warning that needs "save anyway" says so.', seen: 'scribed part numbers on a numbered layer; also how some programs export inner contours', parts, plate: PS, devCheck: false,
      text: doc([...nestEnts(PS, parts), box('LAYER_3', r1.x + 100, r1.y + 250), box('LAYER_3', r1.x + 160, r1.y + 250), box('LAYER_3', cope.x + 300, cope.y + 100)]), expect: expectOf(parts, 'code', { status: 'warning', warnings: ['MARKING_UNSURE'], check: noCut }) });
    add('k-real-programs', N12(119), { what: 'The same two closed shapes inside a part with NO drawing, on the CUT layer itself, in the cut colour. They may be windows or scribed letters — nothing can tell. They are stored as cut-outs taken from the nesting file, with a warning that needs "save anyway".', seen: 'single-layer exports', parts: [parts[0], parts[2]], plate: PS, devCheck: false,
      text: doc([...nestEnts(PS, [parts[0], parts[2]]), box('PARTS', r1.x + 100, r1.y + 250), box('PARTS', r1.x + 160, r1.y + 250)]), expect: expectOf([parts[0], parts[2]], 'code', { status: 'warning', warnings: ['CUTOUTS_FROM_FILE'], check: (e) => (e.placements.some((p) => p.shapeFrom === 'nesting file' && p.rings.cutouts.length === 2) ? [] : ['the part does not say its shape came from the nesting file']) }) });
  }
  {
    // Cut and mark told apart only by COLOUR: one layer, red = cut, yellow = a marking line from edge to edge.
    const x = 100; const y = 100; const c = [[x, y], [x + 1200, y], [x + 1200, y + 400], [x, y + 400]];
    const one = [...c.map((p, i) => LINE('CUT', p, c[(i + 1) % 4], [62, 1])), LINE('CUT', [x + 600, y], [x + 600, y + 400], [62, 2]), TEXT('CUT', [x + 300, y + 200], 30, code('R1'))];
    parts = [P('R2', 100, 700)];
    add('k-real-programs', N12(107), { what: 'Cut and marking on ONE layer, told apart only by colour: a part drawn as red LINEs with a yellow marking line across it from edge to edge.', seen: 'Lantek / SigmaNEST / TruTops colour-coded DXF (colour = technology)', devCheck: false, text: doc([...nestEnts(PS, parts, { partLayer: 'CUT', labelLayer: 'CUT' }), ...one]), expect: { status: 'ok', plateBy: 'size', parts: 2, placed: 2, by: { label: 2 }, errors: {}, warnings: [] } });
  }
  parts = shelf([['T1', 90], ['T2', 90], ['X1'], ['X2'], ['COPE'], ['R1']], PS).map((p, i) => ({ ...p, label: [code(p.key), String(i + 1), '12THK'] }));
  add('k-real-programs', N12(108), { what: 'Three texts in every part: our code, the cut sequence number ("1", "2" …) and "12THK".', seen: 'SigmaNEST / ProNest nest reports exported to DXF', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });
  parts = mix();
  add('k-real-programs', 'N109.dxf', { what: 'The grade written in full in the title: "MATERIAL: IS 2062 E350 BR   THK 12". Our catalog plate says E350.', seen: 'every Indian mill certificate and most title blocks', parts, plate: PS, text: doc([...nestEnts(PS, parts), TEXT('TITLE', [0, -200], 60, 'MATERIAL: IS 2062 E350 BR   THK 12', { centred: false })]), expect: expectOf(parts, 'code') });
  add('k-real-programs', 'N110_12mm_E350BR_3000x1500.dxf', { what: 'The same in the file name: E350BR.', seen: 'file naming by full grade', parts, plate: PS, text: doc(nestEnts(PS, parts)), expect: expectOf(parts, 'code') });
  {
    parts = shelf([['COPE'], ['HOLES'], ['R1']], { length: 1900, width: 1500 });
    add('k-real-programs', N12(111), { what: 'A REMNANT (crop) line: the plate drawn as four LINEs and a fifth from edge to edge at x = 2000, on layer REMNANT, marking the offcut to keep.', seen: 'SigmaNEST / ProNest / Lantek remnant cut-off line', parts, plate: PS, text: doc([...nestEnts(PS, parts, { plate: 'lines' }), LINE('REMNANT', [2000, 0], [2000, 1500])]), expect: expectOf(parts, 'code') });
  }
  {
    const up = { length: 1500, width: 3000 };
    parts = shelf([['COPE'], ['HOLES'], ['TRAP'], ['R1'], ['R2']], up);
    add('k-real-programs', N12(112), { what: 'The plate drawn STANDING UP (1500 wide, 3000 high).', seen: 'machines whose long axis is Y', parts, plate: up, text: doc(nestEnts(up, parts)), expect: expectOf(parts, 'code') });
  }
  {
    parts = mix();
    const ents = nestEnts(PS, parts);
    add('k-real-programs', N12(113), { what: 'Every entity in the file TWICE, one on top of the other.', seen: 'copy-paste in CAD; exports that write visible and hidden copies', parts, plate: PS, text: doc([...ents, ...ents]), expect: expectOf(parts, 'code') });
  }
  {
    // Corner loops: every edge overshoots the corner by 6 mm and the torch loops round outside it.
    const x = 100; const y = 100; const l = 1200; const w = 400; const d = 6;
    const c = [[x, y], [x + l, y], [x + l, y + w], [x, y + w]]; const dir = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const loops = [];
    for (let i = 0; i < 4; i++) {
      const a = c[i]; const b = c[(i + 1) % 4]; const ud = dir[i]; const un = dir[(i + 1) % 4];
      const end = [b[0] + d * ud[0], b[1] + d * ud[1]];
      loops.push(LINE('PARTS', [a[0] - d * ud[0], a[1] - d * ud[1]], end), LINE('PARTS', end, [b[0] - d * un[0], b[1] - d * un[1]]));
    }
    parts = [P('R2', 100, 700)];
    add('k-real-programs', N12(114), { what: 'CORNER LOOPS: at each corner of a part the cut runs 6 mm past, loops round outside and comes back along the next edge, to keep the corner sharp.', seen: 'plasma / oxy-fuel toolpaths: AVEVA ("corner loops"), SigmaNEST, ProNest', devCheck: false, text: doc([...nestEnts(PS, parts), ...loops, TEXT('LABELS', [x + l / 2, y + w / 2], 30, code('R1'))]), expect: { status: 'ok', plateBy: 'size', parts: 2, placed: 2, by: { label: 2 }, errors: {}, warnings: [] } });
  }
  {
    // Two plates in one file, side by side.
    const a = shelf([['COPE'], ['R1']], PS); const b = shelf([['HOLES'], ['R2'], ['TRAP']], PS);
    add('k-real-programs', 'JOB-114_all_sheets_12mm_E350_3000x1500.dxf', { what: 'TWO PLATES IN ONE FILE, side by side (2 parts on the first, 3 on the second). One file is one plate here, so this must be REFUSED in words — reading one plate and silently dropping the other is the worst answer.', seen: 'Deepnest ("export all sheets"), SigmaNEST / ProNest job export, AutoCAD layouts', devCheck: false, text: doc([...nestEnts(PS, a), ...nestEnts(PS, b, { origin: [3500, 0] })]), expect: { status: 'error', errors: { MULTIPLE_PLATES: 1 }, check: (e) => (/holds 2 plates/.test(e.errors[0]?.message ?? '') ? [] : ['the message does not say how many plates the file holds']) } });
    const flat = { plateLayer: '0', partLayer: '0', labelLayer: '0' };
    add('k-real-programs', 'JOB-115_all_sheets.dxf', { what: 'The same two plates with EVERYTHING on layer 0 and a file name that says nothing.', seen: 'Deepnest ("export all sheets"); AutoCAD with layers flattened', devCheck: false, text: doc([...nestEnts(PS, a, flat), ...nestEnts(PS, b, { ...flat, origin: [3500, 0] })]), expect: { status: 'error', errors: { MULTIPLE_PLATES: 1 } } });
  }
  parts = [{ ...P('HOLES', 100, 100), shape: rectShape(500, 300), label: null, rule: 'size' }, { ...P('R1', 100, 600), label: null, rule: 'size' }];
  add('k-real-programs', 'N115_12mm_E350_3000x1500.dxf', { what: 'DRILLED HOLES LEFT OUT of the nest: a part whose drawing has six holes is drawn as a bare 500 × 300 rectangle, unlabelled. It should still be recognised (by its size) and stored as our drawing.', seen: 'nests where holes are drilled later and the nester strips them', devCheck: false, text: doc(nestEnts(PS, parts, { labels: 'none' })), expect: expectOf(parts, 'none') });
  {
    // A part with NO drawing that the customer drew with two corners chamfered.
    const cham = { name: 'r1-chamfered', symmetry: { rot: 1, mirror: true }, loops: [{ v: [[0, 0], [1200, 0], [1200, 340], [1140, 400], [60, 400], [0, 340]] }] };
    parts = [{ ...P('R1', 100, 100), shape: cham }, P('R2', 100, 700)];
    add('k-real-programs', N12(116), { what: 'A cut piece we hold only as a rectangle (no drawing), drawn in the nest with its true outline (two corners chamfered) and labelled with our code. The customer\'s outline should be kept for this plate and the answer should say where the shape came from.', seen: 'the normal case until every part drawing is uploaded', devCheck: false, text: doc(nestEnts(PS, parts)), expect: { status: 'ok', plateBy: 'size', parts: 2, placed: 2, by: { label: 2 }, errors: {}, warnings: [], check: (e) => (e.placements.some((p) => p.shapeFrom === 'nesting file') ? [] : ['no placement says shapeFrom: "nesting file"']) } });
  }
}

/* ───────────────────────────── run ───────────────────────────── */

const J = (v) => JSON.stringify(v);
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nest reference files' };
const results = [];
let fixtureNote = '';
let broke = null;

const holeRing = (h) => (Array.isArray(h) ? h : Array.from({ length: 72 }, (_, k) => [h.cx + (h.d / 2) * Math.cos(k * 5 * RAD), h.cy + (h.d / 2) * Math.sin(k * 5 * RAD)]));
const ringsOfPlacement = (p) => [p.rings.outline, ...p.rings.cutouts, ...p.rings.holes.map(holeRing)];
const drawnRings = (part) => RD.placeRings(part.shape.loops.map(D.flattenLoop), { x: part.x, y: part.y, rotationDeg: part.rotationDeg ?? 0, mirrored: !!part.mirrored });
const boxMin = (rings) => [Math.min(...rings[0].map((p) => p[0])), Math.min(...rings[0].map((p) => p[1]))];

/** Every matched part is stored where the file drew it: the worst outline-to-outline distance (mm), and how many found no placement. */
function fidelity(entry, parts, noPlate) {
  const expected = parts.map((p) => drawnRings(p));
  let shift = [0, 0];
  if (noPlate && entry.plate) { const mins = expected.map(boxMin); shift = [(entry.plate.offset?.[0] ?? 0) - Math.min(...mins.map((m) => m[0])), (entry.plate.offset?.[1] ?? 0) - Math.min(...mins.map((m) => m[1]))]; }
  const left = entry.placements.slice();
  let worst = 0; let lost = 0;
  for (const rings0 of expected) {
    const rings = rings0.map((r) => r.map(([x, y]) => [x + shift[0], y + shift[1]]));
    const [bx, by] = boxMin(rings);
    const i = left.findIndex((p) => Math.abs(p.x - bx) <= 0.6 && Math.abs(p.y - by) <= 0.6);
    if (i < 0) { lost += 1; continue; }
    const [pl] = left.splice(i, 1);
    worst = Math.max(worst, RD.ringsDeviation(ringsOfPlacement(pl), rings));
  }
  return { worst, lost };
}

const tallyCodes = (list) => { const m = {}; for (const x of list) m[x.code] = (m[x.code] ?? 0) + 1; return m; };
const sameMap = (a, b) => J(Object.entries(a).sort()) === J(Object.entries(b).sort());
const byOf = (e) => { const m = {}; for (const p of e.placements) m[p.by] = (m[p.by] ?? 0) + 1; return m; };
const mapWords = (m) => Object.entries(m).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', ');

function answerWords(e, out) {
  const bits = [e.status];
  if (e.plate?.code) bits.push(`plate by ${e.plate.resolvedBy}${e.plate.drawn ? '' : ' (not drawn)'}`); else if (e.parts) bits.push('plate not found');
  if (e.parts) bits.push(`matched ${e.placed} of ${e.parts}${e.placed ? ` (${mapWords(byOf(e))})` : ''}`);
  const errs = tallyCodes(e.errors); if (Object.keys(errs).length) bits.push(`errors: ${mapWords(errs)}`);
  const warns = tallyCodes(e.warnings); if (Object.keys(warns).length) bits.push(`warnings: ${mapWords(warns)}`);
  const req = (out?.warningList ?? []).filter((w) => w.code === 'OVER_COVERAGE'); if (req.length) bits.push(`request warning: OVER_COVERAGE ×${req.length}`);
  return bits.join(' · ');
}
function expectWords(x) {
  const bits = [];
  if (x.status) bits.push(x.status);
  if ('plateBy' in x) bits.push(x.plateBy ? `plate by ${x.plateBy}` : 'no plate');
  if (x.parts != null) bits.push(`matched ${x.placed ?? '?'} of ${x.parts}${x.by && Object.keys(x.by).length ? ` (${mapWords(x.by)})` : ''}`);
  if (x.errors && Object.keys(x.errors).length) bits.push(`errors: ${mapWords(x.errors)}`);
  if (x.warnings?.length) bits.push(`warnings: ${x.warnings.join(', ')}`);
  if (x.req?.length) bits.push(`request warning: ${x.req.join(', ')}`);
  if (x.check) bits.push('+ a check of the answer\'s content');
  return bits.join(' · ');
}
function judge(e, x, out, cs) {
  const miss = [];
  if (x.status && e.status !== x.status) miss.push(`status is ${e.status}, expected ${x.status}`);
  if ('plateBy' in x && (e.plate?.resolvedBy ?? null) !== x.plateBy) miss.push(`plate resolved by ${e.plate?.resolvedBy ?? 'nothing'}, expected ${x.plateBy ?? 'nothing'}`);
  if (x.parts != null && e.parts !== x.parts) miss.push(`${e.parts} parts found, expected ${x.parts}`);
  if (x.placed != null && e.placed !== x.placed) miss.push(`${e.placed} matched, expected ${x.placed}`);
  if (x.by && !sameMap(byOf(e), x.by)) miss.push(`matched by {${mapWords(byOf(e))}}, expected {${mapWords(x.by)}}`);
  if (x.errors && !sameMap(tallyCodes(e.errors), x.errors)) miss.push(`errors {${mapWords(tallyCodes(e.errors))}}, expected {${mapWords(x.errors)}}`);
  if (x.warnings && J([...new Set(e.warnings.map((w) => w.code))].sort()) !== J([...x.warnings].sort())) miss.push(`warnings {${mapWords(tallyCodes(e.warnings))}}, expected {${x.warnings.join(', ')}}`);
  for (const r of x.req ?? []) if (!(out.warningList ?? []).some((w) => w.code === r && w.needsForce)) miss.push(`no ${r} warning on the request`);
  if (x.check) { try { miss.push(...x.check(e, out)); } catch (err) { miss.push(`check threw: ${err.message}`); } }
  if (cs?.parts && cs.plate && cs.devCheck !== false && x.status !== 'error' && e.placed) {
    const fd = fidelity(e, cs.parts.filter((p) => p.key), !!cs.noPlate);
    if (fd.lost) miss.push(`${fd.lost} part(s) are not stored where the file drew them`);
    if (fd.worst > 0.5) miss.push(`a stored outline is ${fd.worst.toFixed(2)} mm off the file's`);
  }
  return miss;
}

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  console.log('\nFixture');
  const fx = await buildFixture(conn);
  const ctx = await N.importContext(conn, COMPANY, fx.lineId);
  const facts = await DR.drawingFactsOfLine(conn, COMPANY, fx.lineId);
  const pieceTotal = Object.values(PARTS).reduce((a, p) => a + p.qty, 0);
  const seen = Object.keys(PARTS).filter((k) => ctx.cutPlates.find((cp) => cp.id === fx.cut[k])?.pieces === PARTS[k].qty).length;
  const withShape = [...facts.values()].filter((v) => v.rings).length;
  fixtureNote = `line ${fx.lineId}: ${seen} of ${Object.keys(PARTS).length} cut pieces seen by the nesting survey, ${pieceTotal} pieces, ${withShape} with a drawing`;
  console.log(`  ${fixtureNote}`);
  if (seen !== Object.keys(PARTS).length || withShape !== Object.values(PARTS).filter((p) => p.drawn).length) throw new Error('The fixture is not what the nesting survey sees — stopping.');

  /* ---- a: our own automatic nest, accepted, exported by the CNC writer ---- */
  console.log('\nAutomatic nest → our CNC export (group a)');
  let autoNote = '';
  let ruleNote = '';
  try {
    const plan = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1 });
    // THE DRAWING DECIDES (2026-10-13): the same line under the rule as it was — true shapes only when they beat the rows — to show the cost.
    const was = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 1, drawingsDecide: false });
    const words = (p) => `${p.totals.plates} plates, ${(p.totals.areaBought / 1e6).toFixed(3)} m² bought, ${p.totals.wastePct}% waste (${p.totals.partsKg} kg of parts in ${p.totals.weightKg} kg of plate), ${p.totals.unplaced} left off; layouts by steel: ${p.groups.map((g) => `${g.thickness} mm ${g.grade} ${g.shapes?.taken === 'shape' ? 'true-shape' : 'rows'} ×${g.nests.length}`).join(', ')}`;
    ruleNote = `Before (true-shape layout only when it beats the rows): ${words(was)}. After (a steel with a drawing that is not a rectangle always takes the true-shape layout unless it leaves more pieces off): ${words(plan)}`;
    console.log(`  ${ruleNote}`);
    const acc = await N.acceptNesting(conn, c, fx.lineId, plan);
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    const nests = view.groups.flatMap((g) => g.nests);
    const mineOnly = nests.every((n) => Object.values(fx.plates).includes(Number(n.plateItemId)));
    autoNote = `${acc.lots ?? nests.length} plates, ${nests.reduce((a, n) => a + n.pieces.length, 0)} pieces; layouts: ${nests.map((n) => `${n.lotNo} ${n.plateCode} ${n.layout === 'free' ? 'true-shape' : 'rows'}`).join('; ')}${mineOnly ? '' : ' — WARNING: a tenant plate was used'}`;
    console.log(`  ${autoNote}`);
    let main = null;
    for (const n of nests) {
      const file = await CNC.lotDxf(conn, COMPANY, fx.lineId, n.id);
      const text = file.buffer.toString('latin1');
      const keys = n.pieces.map((p) => fx.keyOfCut(p.cutPlateId));
      const pseudo = keys.map((k) => ({ key: k }));
      add('a-own-cnc-export', file.filename, { what: `Our CNC export of automatic nest ${n.lotNo}: ${n.pieces.length} pieces on ${n.plateCode} (${n.layout === 'free' ? 'a true-shape layout' : 'a row layout'}). R12 POLYLINEs on layers PLATE / PARTS / LABELS / OFFCUTS, a code in every part, the offcuts drawn and named, a title line under the plate.`, seen: 'this app (GET …/nesting/cnc)', text, expect: expectOf(pseudo, 'code') });
      if (!main || n.pieces.length > main.n.pieces.length) main = { n, text, keys, filename: file.filename };
    }
    if (main) {
      const codeToKey = new Map(Object.keys(PARTS).map((k) => [code(k), k]));
      const pseudo = main.keys.map((k) => ({ key: k }));
      const swap = splitEntities(main.text);
      for (const ent of swap.ents) if (ent[1].trim() === 'TEXT') for (let i = 0; i < ent.length; i += 2) if (String(ent[i]).trim() === '1' && codeToKey.has(ent[i + 1].trim())) ent[i + 1] = PARTS[codeToKey.get(ent[i + 1].trim())].cust;
      add('b-customer-marks', main.filename, { what: `Our CNC export of nest ${main.n.lotNo} with every part label replaced by the customer's mark (PM-2xx). The plate, the offcuts and the title line are as we wrote them. The identical-shape pieces on it cannot be told apart.`, seen: 'a customer nest in the same layout as ours', text: joinEntities(swap), expect: expectOf(pseudo, 'cust') });
      const bare = splitEntities(main.text);
      bare.ents = bare.ents.filter((ent) => ent[1].trim() !== 'TEXT');
      add('c-no-labels', main.filename, { what: `Our CNC export of nest ${main.n.lotNo} with every TEXT removed (part labels, offcut names, the title line).`, seen: 'a nest exported with text switched off', text: joinEntities(bare), expect: expectOf(pseudo, 'none') });
    }
    const lots = (await conn.query("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, fx.lineId]))[0];
    for (const lot of lots) await U.deleteNestLot(conn, c, fx.lineId, lot.id);
  } catch (e) {
    autoNote = `NOT MADE — the automatic nest or its export failed: ${e.message}`;
    console.log(`  ${autoNote}`);
    const lots = (await conn.query("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [COMPANY, fx.lineId]))[0];
    for (const lot of lots) await U.deleteNestLot(conn, c, fx.lineId, lot.id).catch(() => {});
  }
  fixtureNote += `. Automatic nest: ${autoNote}${ruleNote ? `. ${ruleNote}` : ''}`;

  defineCases();
  const order = Object.keys(GROUPS);
  cases.sort((p, q) => order.indexOf(p.group) - order.indexOf(q.group));

  /* ---- write the files ---- */
  for (const g of order) fs.rmSync(path.join(OUT_DIR, g), { recursive: true, force: true });
  const bufOf = (x) => (x.buffer ?? Buffer.from(x.text, 'latin1'));
  for (const cs of cases) {
    fs.mkdirSync(path.join(OUT_DIR, cs.group), { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, cs.group, cs.filename), bufOf(cs));
    for (const m of cs.more ?? []) fs.writeFileSync(path.join(OUT_DIR, cs.group, m.filename), bufOf(m));
  }

  /* ---- the upload preview of every file ---- */
  console.log(`\nUpload preview of ${cases.length} cases (dry run — nothing is saved)\n`);
  const answers = new Map();
  for (const cs of cases) {
    const files = [cs, ...(cs.more ?? [])].map((x) => ({ filename: x.filename, file: bufOf(x).toString('base64'), ...(x.plateCode ? { plateCode: x.plateCode } : {}) }));
    let choices;
    if (cs.choicesFrom) {
      // The user's picks: for each ambiguous part of the earlier answer, the first choice nobody has taken yet.
      const prev = answers.get(cs.choicesFrom); const taken = new Set(); const pick = {};
      for (const pl of prev?.files[0].placements.filter((x) => x.by === 'quantity' && x.alternatives?.length) ?? []) pick[pl.partId] = pl.alternatives[0].cutPlateId;
      for (const er of prev?.files[0].errors.filter((x) => x.code === 'PART_AMBIGUOUS') ?? []) { const ch = er.choices.find((o) => !taken.has(o.cutPlateId)) ?? er.choices[0]; taken.add(ch.cutPlateId); pick[er.partId] = ch.cutPlateId; }
      choices = { [cs.filename]: pick };
    }
    let out; let threw = null;
    try { out = await U.uploadNestFiles(conn, c, fx.lineId, { files, dryRun: true, ...(choices ? { choices } : {}) }); } catch (e) { threw = e; }
    answers.set(cs.filename, out);
    const expects = [cs.expect, ...(cs.expectMore ?? [])];
    files.forEach((fl, i) => {
      const x = expects[i];
      if (threw) { results.push({ cs, filename: fl.filename, x, got: `THREW ${threw.code ?? ''} ${threw.message}`, miss: ['the preview threw instead of answering'], said: threw.message }); return; }
      const e = out.files[i];
      const miss = judge(e, x, out, i === 0 ? cs : null);
      const said = [...e.errors.map((er) => er.message), ...e.warnings.map((w) => w.message), ...e.notes].slice(0, 4);
      results.push({ cs, filename: fl.filename, x, got: answerWords(e, out), miss, said, saved: out.applied });
      // NRF_SHOW=N43 … prints the whole answer of the files whose name holds that text.
      if (process.env.NRF_SHOW && fl.filename.includes(process.env.NRF_SHOW)) console.log(JSON.stringify({ file: fl.filename, errors: e.errors.map((q) => q.message), warnings: e.warnings.map((q) => q.message), notes: e.notes, placements: e.placements.map((q) => ({ code: q.cutPlateCode, by: q.by, x: q.x, y: q.y, rot: q.rotationDeg, mir: q.mirrored, shapeFrom: q.shapeFrom, cutouts: q.rings.cutouts.length, holes: q.rings.holes.length })) }, null, 1));
    });
  }
  const lotsLeft = Number((await conn.query('SELECT COUNT(*) n FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, fx.lineId]))[0][0].n);
  if (lotsLeft || results.some((r) => r.saved)) throw new Error('A preview wrote something — it must not.');
} catch (e) {
  broke = e;
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

/* ───────────────────────────── the table, the manifest ───────────────────────────── */

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
const [[rel923]] = await pool.query('SELECT COUNT(*) AS n FROM cf_production_releases WHERE order_line_id = 923 AND deleted_at IS NULL');
const [[leftover]] = await pool.query('SELECT COUNT(*) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [COMPANY, `${TAG}-%`]);

const pass = results.filter((r) => !r.miss.length).length;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
let lastGroup = null;
for (const r of results) {
  if (r.cs.group !== lastGroup) { lastGroup = r.cs.group; console.log(`\n${GROUPS[r.cs.group]}`); }
  console.log(`  ${r.miss.length ? 'FAIL' : 'PASS'}  ${r.cs.group}/${r.filename}`);
  console.log(`        expected: ${expectWords(r.x)}`);
  console.log(`        answered: ${r.got}`);
  for (const m of r.miss) console.log(`        ✗ ${m}`);
  if (r.miss.length) for (const s of r.said.slice(0, 2)) console.log(`        app: ${cut(s, 260)}`);
}
console.log(`\n${pass} PASS, ${results.length - pass} FAIL of ${results.length} files (${cases.length} uploads).`);
console.log(`Rolled back: ${drift.length ? `NOT CLEAN — ${drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', ')}` : 'every cf_ table is back to the count it started at'}; ${leftover.n} ${TAG}- records left; line 923 releases: ${rel923.n}.`);

if (results.length) {
  const esc = (s) => String(s).replaceAll('|', '\\|').replace(/\s+/g, ' ');
  const md = [];
  md.push('# Reference nesting DXF files — CF_ERP "upload nesting files"', '');
  md.push('Written by `multi_app_be/scripts/cf_kepl/nest-reference-files.mjs` (run it again to rewrite every file and this manifest; the FINDINGS section at the end is written by hand and is kept).', '');
  md.push(`One DXF = one raw plate. Every file was fed through the upload PREVIEW (\`uploadNestFiles\`, \`dryRun: true\` — the function behind \`POST /orders/:orderId/lines/:lineId/nesting/files\`); nothing was saved and the whole fixture was rolled back, so **these files cannot be uploaded to a real line** — the cut-piece codes in them (NRF-CP-xx) exist only inside the script's transaction. They are a reference of what the reader meets, and the script is the way to re-measure it.`, '');
  md.push(`**Result of the last run: ${pass} PASS, ${results.length - pass} FAIL of ${results.length} files.** "Expected" is what the app SHOULD do with the file; a FAIL is a gap in the reader or the upload service, explained under FINDINGS.`, '');
  md.push('## The line the files are for', '');
  md.push(`Fixture: ${fixtureNote}.`, '');
  md.push('| Cut piece | Our code | Drawing mark | Customer\'s mark | Steel | Size | Qty | Shape |', '|---|---|---|---|---|---|---|---|');
  const shapeWords = { COPE: 'drawing: one corner coped (R60 arc)', HOLES: 'drawing: six 22 mm holes', TRAP: 'drawing: trapezoid', ELL: 'drawing: L', T1: 'drawing: sniped stiffener', T2: 'drawing: **identical to NRF-CP-05**', BASE: 'drawing: 120 mm opening + four 26 mm holes', X2: 'rectangle, **identical to NRF-CP-10**', K3: 'rectangle, the same as NRF-CP-09 in 20 mm' };
  for (const [k, p] of Object.entries(PARTS)) md.push(`| ${k} | ${code(k)} | ${mark(k)} | ${p.cust} | ${p.t} mm ${p.grade} | ${p.length} × ${p.width} | ${p.qty} | ${shapeWords[k] ?? 'rectangle (no drawing)'} |`);
  md.push('', `Catalog plates: ${Object.values(PLATES).map((p) => `\`${p.code}\``).join(', ')}. Three of them are 3000 × 1500 and are told apart only by thickness and grade. Kerf 3 mm.`, '');
  md.push('How to read "expected / answered": `status` (ok / warning / error) · how the plate was found (`size` = from the drawn border or a size in the words / file name, `code` = named in the request) · parts matched n of n and by which rule (`label` = a code we know and the shape agrees, `shape` = the drawing\'s outline at any angle and hand, `size` = a rectangle of the right size, `steel` = two cut pieces of one shape told apart by the plate\'s thickness, `quantity` = identical cut pieces shared out by what the line still needs, `choice` = the user said) · error and warning codes (CF_ERP_NESTING_V2.md §2.3).', '');
  md.push('## Files', '');
  let g = null;
  for (const r of results) {
    if (r.cs.group !== g) { g = r.cs.group; md.push('', `### ${GROUPS[g]}`, '', '| | File | What it represents | Written like this by | Expected | The app answered |', '|---|---|---|---|---|---|'); }
    const first = r.filename === r.cs.filename;
    md.push(`| **${r.miss.length ? 'FAIL' : 'PASS'}** | \`${g}/${r.filename}\` | ${esc(first ? r.cs.what : 'the second copy of the file above')} | ${esc(first ? r.cs.seen : '')} | ${esc(expectWords(r.x))} | ${esc(r.got)}${r.miss.length ? `<br>✗ ${r.miss.map(esc).join('<br>✗ ')}${r.said.length ? `<br>_app: ${esc(cut(r.said[0], 300))}_` : ''}` : ''} |`);
  }
  md.push('', '## Result table', '', '| | File | Expected | Answered |', '|---|---|---|---|');
  for (const r of results) md.push(`| ${r.miss.length ? 'FAIL' : 'PASS'} | \`${r.cs.group}/${r.filename}\` | ${esc(expectWords(r.x))} | ${esc(r.got)} |`);
  md.push('');
  const file = path.join(OUT_DIR, 'MANIFEST.md');
  let keep = `${FINDINGS_MARK}\n\n## FINDINGS\n\n(not written yet)\n`;
  if (fs.existsSync(file)) { const old = fs.readFileSync(file, 'utf8'); const i = old.indexOf(FINDINGS_MARK); if (i >= 0) keep = old.slice(i); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, `${md.join('\n')}\n${keep}`);
  console.log(`Files and MANIFEST.md are in ${OUT_DIR}`);
}
if (broke) { console.error(`\nTHE SCRIPT BROKE: ${broke.stack ?? broke.message}`); }
await pool.end();
process.exit(broke || drift.length ? 1 : 0);
