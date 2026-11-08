/**
 * model_values_test.mjs — values from the 3D model (2026-11-08, services/modelValueService.js, lib/modelValues.js,
 * init.sql §100; TM/plans/values-from-model.md).
 *
 *   1  the geometry, no database: five parts of each drawing set checked by hand against its model.json
 *      (RDSO 45.7 m: BC1F1, BC1W, U1-G1, BCA, U1-P2; Thane 75 m: BCE-TP, BCE-WB, BB1, TS20, JL0A-L100), and a small
 *      model of our own for the bolt grip through a plate and the T-joint weld length;
 *   2  on the database, a fixture line of this run's own (a span with a bottom chord BC1 and its flange, web and
 *      diaphragm angles, gussets U1-G1, a bent plate U1-P2, a row the model does not have), tied to a standard:
 *      no model yet → nothing written, the Values screen says "waiting for the 3D model"; the model attached → sizes,
 *      holes, drilled thickness, facts and the weld written with source 'model', the weights worked out after them,
 *      typed values kept, disagreements listed, piece counts reported, open required values fewer; accept a
 *      disagreement; a second run changes nothing; a new model rewrites only 'model' values; a person typing over
 *      a model value is kept; the design signature does not move; a locked line is reported, not written;
 *      the standard's version computed and a line made from it carries the values (the drawing refresh keeps them);
 *      round trips do not grow with the rows.
 *
 * Local only, company 2 (CF_MODEL_COMPANY), ONE rolled-back transaction, every cf_ table re-counted.
 *   cd multi_app_be && node scripts/cf_kepl/model_values_test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { marksOfModel, holeDrillThickness, weldLengths, weldSizeFor, pieceShape, normMark } from '../../apps/cf_erp/lib/modelValues.js';
import { applyModel, valuesForRow, sameFor } from '../../apps/cf_erp/services/modelValueService.js';
import { readLineValues, writeLineValues } from '../../apps/cf_erp/services/orderValuesService.js';
import { createStandard, saveLineToStandard, addLineFromStandard, lineStandard } from '../../apps/cf_erp/services/standardDrawingService.js';
import { createRule } from '../../apps/cf_erp/services/assignmentService.js';
import { attachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as MR from '../../apps/cf_erp/services/masterRecordService.js';
import * as B from '../../apps/cf_erp/services/bomService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as PARTIES from '../../apps/cf_erp/modules/parties/service.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('Local only.');
const COMPANY = Number(process.env.CF_MODEL_COMPANY ?? 2);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drawing_bom', 'out');
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`); cond ? passed++ : failed++; };
const near = (a, b, tol = 0.01) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
const readModel = (set) => JSON.parse(fs.readFileSync(path.join(OUT, set, 'model.json'), 'utf8'));

/* ===========================================================================
 * 1. The geometry (no database)
 * ======================================================================== */
console.log('\n  1. the geometry, by hand against model.json');
const rdso = readModel('RDSO_45M7');
const thane = readModel('TCPL_TRUSS_75M_R2');
const bbox = (pts) => { const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
{
  const M = marksOfModel(rdso);
  // BC1F1: drawn in two segments end to end (a kink at the chord's camber), 6210.42 + 5904.58 = 12115 long, 150 wide,
  // 12 thick, 17 + 23 = 40 holes; 2 per BC1 × 2 BC1 = 4 pieces. bom.json: 12115 × 150 × 12, 40 holes.
  const [a, b] = [bbox(rdso.parts.BC1F1.pts), bbox(rdso.parts['BC1F1#2'].pts)];
  const f1 = M.get('BC1F1');
  ok(`RDSO BC1F1: ${a[0]} + ${b[0]} = 12115 × 150 × 12, 40 holes, 4 pieces`, near(a[0] + b[0], 12115) && f1.shape.lengthMm === 12115 && f1.shape.widthMm === 150 && f1.shape.t === 12 && f1.shape.holes === 40
    && rdso.parts.BC1F1.holes.length + rdso.parts['BC1F1#2'].holes.length === 40 && f1.pieces === 4, JSON.stringify(f1.shape));
  // BC1W: one outline 12115.53 × 548, 12 thick, 145 holes.
  const w = M.get('BC1W'); const wb = bbox(rdso.parts.BC1W.pts);
  ok(`RDSO BC1W: ${wb[0].toFixed(2)} × ${wb[1]} × 12, ${rdso.parts.BC1W.holes.length} holes (bom.json 12115.5 × 548, 145)`, near(w.shape.lengthMm, 12115.53) && w.shape.widthMm === 548 && w.shape.holes === 145 && w.pieces === 4);
  // U1-G1 (the gusset of joint U1): outline x 0 … 1606.49, y 0 … 1412.25, t 16, 142 holes of 23.5.
  const g = M.get('U1-G1');
  ok('RDSO U1-G1: 1606.49 × 1412.25 × 16, 142 holes Ø23.5', g.shape.lengthMm === 1606.49 && g.shape.widthMm === 1412.25 && g.shape.t === 16 && g.shape.holes === 142 && rdso.parts['U1-G1'].holes.every((h) => h[2] === 23.5));
  // The gusset's area by hand: the shoelace of its 8 corners less 142 holes of Ø23.5.
  const P = rdso.parts['U1-G1'].pts.slice(0, -1); let s2 = 0; for (let i = 0; i < P.length; i++) { const [x1, y1] = P[i]; const [x2, y2] = P[(i + 1) % P.length]; s2 += x1 * y2 - x2 * y1; }
  const hand = Math.abs(s2) / 2 - 142 * Math.PI * 23.5 * 23.5 / 4;
  ok(`…its true area ${hand.toFixed(0)} mm² by hand`, near(g.shape.areaMm2, hand, 0.5), String(g.shape.areaMm2));
  // BCA: an angle ISA 100x100x10 x 450 drawn as its two legs (450 × 100 and 450 × 90, both 10 thick): a section 450 long.
  const bca = M.get('BCA');
  ok('RDSO BCA: an angle\'s two legs → a section 450 long, 10 thick, no width given', bca.shape.kind === 'section' && bca.shape.lengthMm === 450 && bca.shape.widthMm === null && bca.shape.t === 10 && bca.pieces === 128);
  // U1-P2: a bent plate (legs 627.92 × 642 and 631.08 × 837): its flat size is not guessed.
  const p2 = M.get('U1-P2');
  ok('RDSO U1-P2: a bent plate — its flat size left to its part file, its 36 + 47 = 83 holes and 10 mm kept', p2.shape.how === 'bent' && p2.shape.lengthMm === null && p2.shape.holes === 83 && p2.shape.t === 10);
}
{
  const M = marksOfModel(thane);
  const tp = M.get('BCE-TP'); const tb = bbox(thane.parts['BCE-TP'].pts);
  ok(`Thane BCE-TP: ${tb[0]} × ${tb[1]} × 25, 87 holes, one cut-out (bom.json 9975 × 936 × 25, 87)`, tp.shape.lengthMm === 9975 && tp.shape.widthMm === 936 && tp.shape.t === 25 && tp.shape.holes === 87 && thane.parts['BCE-TP'].cuts.length === 1);
  const wbp = M.get('BCE-WB');
  ok('Thane BCE-WB: 9975 × 1075 × 32, 224 holes, 8 pieces', wbp.shape.lengthMm === 9975 && wbp.shape.widthMm === 1075 && wbp.shape.t === 32 && wbp.shape.holes === 224 && wbp.pieces === 8);
  // BB1: a pipe member from a (1662, 1649, 485) to b (7373, 8777, 470): √(5711² + 7128² + 15²) = 9133.68.
  const bb = M.get('BB1'); const e = thane.elements.find((x) => x.mark === 'BB1').member;
  ok(`Thane BB1: a member ${Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]).toFixed(2)} long by hand, wall 10`, near(bb.shape.lengthMm, 9133.68) && bb.shape.t === 10 && bb.shape.kind === 'member');
  // TS20: shear stud grids of 41 × 3 (and the rest) — counted as studs, never sized.
  const ts = M.get('TS20'); const grids = thane.elements.filter((x) => x.mark === 'TS20').reduce((t, x) => t + x.studs.ni * x.studs.nj, 0);
  ok(`Thane TS20: ${grids} studs counted from the grids, no sizes`, ts.pieces === grids && ts.shape.kind === 'studs');
  // JL0A-L100: an angle drawn as its cross-section extruded 600: a section 600 long.
  const l = M.get('JL0A-L100');
  ok('Thane JL0A-L100: a profile extruded by t → a section 600 long', l.shape.kind === 'section' && l.shape.lengthMm === 600 && thane.parts[thane.elements.find((x) => x.mark === 'JL0A-L100').part].t === 600);
}
{
  // A model of our own: a 20 mm plate P on a 12 mm plate Q, a bolt through both (grip 32), and a 10 mm fin F standing on P
  // along 400 mm of its face. By hand: the plies drilled at P are 32; the fin's T-joint is 400 × 2 sides = 800 mm.
  const m = {
    parts: { P: { pts: [[0, 0], [500, 0], [500, 300], [0, 300]], t: 20, holes: [[100, 100, 22]] }, Q: { pts: [[0, 0], [500, 0], [500, 300], [0, 300]], t: 12, holes: [[100, 100, 22]] },
      F: { pts: [[0, 0], [400, 0], [400, 150], [0, 150]], t: 10 } },
    elements: [
      { mark: 'P', in: ['A'], n: [0], part: 'P', o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
      { mark: 'Q', in: ['A'], n: [0], part: 'Q', o: [0, 0, -12], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
      // the fin: its outline in the x–z plane, its edge y = 0 … standing on P's top face (z = 20) at y = 150
      { mark: 'F', in: ['A'], n: [0], part: 'F', o: [50, 145, 20], u: [1, 0, 0], v: [0, 0, 1], w: [0, 1, 0] },
    ],
    boltSet: { cols: ['mark', 'level', 'copy', 'x', 'y', 'z', 'nx', 'ny', 'nz', 'grip', 'd'], rows: [[0, 0, '0', 100, 100, 20, 0, 0, -1, 32, 20]] },
  };
  const d = holeDrillThickness(m);
  ok('a bolt through two plates: the plies drilled at each are its grip (32), not the plate alone', d.get('P')?.grip === 32 && d.get('Q')?.grip === 32 && !d.has('F'), JSON.stringify([...d]));
  const w = weldLengths(m).get('A');
  ok('a 400 mm fin standing on a plate: one T-joint, 2 × 400 = 800 mm of fillet', w?.joints === 1 && near(w.mm, 800, 1), JSON.stringify(w));
  ok('a weld size from bom.json by the member it names ("stringer web to flanges" → Stringer)', weldSizeFor([{ where: 'stringer web to flanges', sizeMm: 12 }, { where: 'box members, webs to flanges', sizeMm: 6 }], 'Stringer STG')?.mm === 12
    && weldSizeFor([{ where: 'box members, webs to flanges', sizeMm: 6 }], 'Bottom chord BC1') === null);
  ok('segments that share a width are joined end to end; an angle\'s legs share the length', pieceShape([m.parts.P, m.parts.P]).lengthMm === 1000 && pieceShape([{ pts: [[0, 0], [450, 0], [450, 100], [0, 100]], t: 10 }, { pts: [[0, 0], [450, 0], [450, 90], [0, 90]], t: 10 }]).kind === 'section');
  const v = valuesForRow({ shape: marksOfModel(m).get('P').shape, file: null, drill: d.get('P') }, new Set(['LENGTH', 'WIDTH', 'THICKNESS', 'HOLES', 'HOLE_DRILL_THICKNESS', 'TRUE_AREA', 'SURFACE_AREA']));
  ok('a row\'s values: 500 × 300 × 20, 1 hole, drilled through 32, area 150000 − π·11²', v.values.get('LENGTH').value === 500 && v.values.get('WIDTH').value === 300 && v.values.get('THICKNESS').value === 20 && v.values.get('HOLES').value === 1
    && v.values.get('HOLE_DRILL_THICKNESS').value === 32 && near(v.values.get('TRUE_AREA').value, 150000 - Math.PI * 121, 0.01));
  ok('equal is within 1 mm for a size, exact for a count', sameFor('LENGTH', 12115, 12115.5) && !sameFor('LENGTH', 12000, 12115) && !sameFor('HOLES', 40, 41));
}

/* ===========================================================================
 * 2. On the database
 * ======================================================================== */
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
const counted = async (fn) => { const real = db.query.bind(db); let n = 0; db.query = (...a) => { n += 1; return real(...a); }; try { return { out: await fn(), n }; } finally { db.query = real; } };
try {
  await db.beginTransaction();
  attachNodeCache(db);
  const c = { companyId: COMPANY, userId: null };
  const tag = `MV${Date.now().toString(36).toUpperCase()}`;

  // ---- specifications the model fills (made where the tenant has none) ----
  const spec = {};
  for (const [code, name, uom, dec] of [['HOLES', 'Holes', null, 0], ['HOLE_DRILL_THICKNESS', 'Hole drilling thickness', 'mm', 2], ['MIG_WELD_LENGTH', 'MIG weld length', 'm', 3],
    ['TRUE_AREA', 'True area', 'mm2', 3], ['DRAWN_HOLES', 'Drawn holes', null, 0], ['DRAWN_HOLE_DIA', 'Drawn hole diameter', 'mm', 2], ['DRAWN_EDGE_LENGTH', 'Drawn edge length', 'mm', 3]]) {
    const [[have]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    spec[code] = have ? Number(have.id) : (await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, 'number', ?, ?, 'active')", [COMPANY, code, name, uom, dec]))[0].insertId;
  }
  const [real] = await db.query("SELECT id, UPPER(code) AS code FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL AND code IN ('LENGTH', 'WIDTH', 'THICKNESS', 'WEIGHT', 'DRAWING_MARK')", [COMPANY]);
  for (const s of real) spec[s.code] = Number(s.id);
  const [nodes] = await db.query("SELECT id, UPPER(code) AS code FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND code IN ('PLATE_PART', 'GIRDER_SEGMENT', 'GIRDER_LINE')", [COMPANY]);
  const node = Object.fromEntries(nodes.map((n) => [n.code, Number(n.id)]));
  ok('the local tenant has the nodes the fixture uses (plate part, assembly, structure) and DRAWING_MARK', node.PLATE_PART && node.GIRDER_SEGMENT && node.GIRDER_LINE && spec.DRAWING_MARK && spec.LENGTH, JSON.stringify(node));

  const tpl = async (key, name, classificationId) => {
    const d = await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${key}`, name: `${name} ${tag}`, shortName: `${tag}${key}`.slice(0, 30) });
    await MR.setStatus(db, c, d.id, 'active');
    return d.id;
  };
  const T = { SPAN: await tpl('SP', 'Span', node.GIRDER_LINE), CHORD: await tpl('BC', 'Bottom chord', node.GIRDER_SEGMENT), FL: await tpl('FL', 'Flange', node.PLATE_PART), WEB: await tpl('WB', 'Web', node.PLATE_PART),
    ANG: await tpl('AN', 'Diaphragm angle', node.PLATE_PART), GUS: await tpl('GU', 'Gusset', node.PLATE_PART), BENT: await tpl('BP', 'Bend plate', node.PLATE_PART), ODD: await tpl('OD', 'Odd plate', node.PLATE_PART) };
  // What the rows are asked for: sizes (the plate part's own rules), holes and the drilled thickness on the parts, the weld on the chord.
  for (const k of ['FL', 'WEB', 'ANG', 'GUS', 'BENT', 'ODD']) {
    for (const code of ['LENGTH', 'HOLES', 'HOLE_DRILL_THICKNESS']) await createRule(db, c, { specificationId: spec[code], subjectType: 'master', subjectId: T[k], captureAt: 'item', valueRule: 'entered', isRequired: true, isApplicable: true });
  }
  await createRule(db, c, { specificationId: spec.MIG_WELD_LENGTH, subjectType: 'master', subjectId: T.CHORD, captureAt: 'item', valueRule: 'entered', isRequired: true, isApplicable: true });
  for (const [p, k, q] of [['CHORD', 'FL', 2], ['CHORD', 'WEB', 2], ['CHORD', 'ANG', 16]]) await B.addLine(db, c, T[p], { childId: T[k], quantity: q });
  await B.setBomStatus(db, c, T.CHORD, 'active');
  for (const [k, q] of [['CHORD', 2], ['GUS', 4], ['BENT', 2], ['ODD', 1]]) await B.addLine(db, c, T.SPAN, { childId: T[k], quantity: q });
  await B.setBomStatus(db, c, T.SPAN, 'active');
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CU`, name: `${tag} bridge co`, roles: ['customer'] });
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `${tag}-SO`, committedDate: '2026-12-31' });
  const made = await SO.addOrderLine(db, c, order.id, { recordId: T.SPAN, quantity: 1 });
  const LINE = made.lines[made.lines.length - 1].id;
  const rowsOf = async (lineId) => (await db.query(
    `SELECT m.id, i.source_definition_id AS def FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id AND m.deleted_at IS NULL
      WHERE i.company_id = ? AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?`, [COMPANY, lineId]))[0];
  const rowMap = (temps) => Object.fromEntries(Object.entries(T).map(([k, id]) => [k, temps.find((t) => Number(t.def) === Number(id))?.id]));
  const R = rowMap(await rowsOf(LINE));
  ok('the fixture line is made: span, chord, flange, web, angle, gusset, bent plate, odd plate', Object.values(R).every(Boolean), JSON.stringify(R));
  // The marks the drawing set gives each row (as the importer writes them: source 'entered').
  const MARK = { SPAN: 'RDSO-45M7-SPAN', CHORD: 'BC1', FL: 'BC1F1', WEB: 'BC1W', ANG: 'BCA', GUS: 'U1-G1', BENT: 'U1-P2', ODD: `${tag}-NOPE` };
  await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_text, source) VALUES ${Object.keys(MARK).map(() => "(?, ?, 'master', ?, ?, 'entered')").join(', ')}`,
    Object.entries(MARK).flatMap(([k, m]) => [COMPANY, spec.DRAWING_MARK, R[k], m]));
  // What a person typed: the flange's width right (150), the web's length wrong (12000 — the model says 12115.53).
  await writeLineValues(db, c, LINE, { writes: [{ recordId: R.FL, specCode: 'WIDTH', value: 150 }, { recordId: R.WEB, specCode: 'LENGTH', value: 12000 }, { recordId: R.ANG, specCode: 'WIDTH', value: 100 }] });

  const stored = async (recordId, code) => {
    const [[v]] = await db.query('SELECT value_number, value_json, source FROM cf_spec_values WHERE company_id = ? AND subject_type = \'master\' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL', [COMPANY, recordId, spec[code]]);
    return v ? { n: v.value_number == null ? null : Number(v.value_number), source: v.source } : null;
  };
  const cellOf = (view, recordId, code) => {
    for (const g of view.groups) { const r = g.rows.find((x) => x.id === recordId); if (r && r.cells[code]) { const col = g.columns.find((x) => x.code === code); return { ...r.cells[code], from: 'from' in r.cells[code] ? r.cells[code].from : col.from ?? null }; } }
    return null;
  };

  console.log('\n  2. no model yet');
  const std = await createStandard(db, c, { number: `${tag}-STD`, name: `${tag} 45.7 m span` }, { lineId: LINE });
  const none = await applyModel(db, c, { lineId: LINE });
  ok('no model attached: nothing is computed, nothing written', none.skipped === 'no_model' && none.written === 0);
  const v0 = await readLineValues(db, COMPANY, LINE);
  ok('the Values screen says the model is not attached, and the empty sizes wait for it', v0.model?.attached === false && cellOf(v0, R.FL, 'LENGTH')?.waitingModel === true && cellOf(v0, R.GUS, 'HOLES')?.waitingModel === true
    && !cellOf(v0, R.FL, 'WIDTH')?.waitingModel, JSON.stringify({ m: v0.model, c: cellOf(v0, R.FL, 'LENGTH') }));

  console.log('\n  3. the model attached');
  const text = fs.readFileSync(path.join(OUT, 'RDSO_45M7', 'model.json'), 'utf8');
  const attach = async (t) => {
    await db.query("UPDATE cf_standard_drawing_files SET deleted_at = NOW() WHERE company_id = ? AND standard_id = ? AND kind = 'model' AND deleted_at IS NULL", [COMPANY, std.id]);
    await db.query("INSERT INTO cf_standard_drawing_files (company_id, version_id, standard_id, kind, file_name, file_kind, file_text) VALUES (?, NULL, ?, 'model', 'model.json', 'json', ?)", [COMPANY, std.id, t]);
  };
  await attach(text);
  const bom = JSON.parse(fs.readFileSync(path.join(OUT, 'RDSO_45M7', 'bom.json'), 'utf8'));
  const sigBefore = (await lineStandard(db, COMPANY, LINE));
  const run1 = await counted(() => applyModel(db, c, { lineId: LINE, bom }));
  const r1 = run1.out;
  ok(`values written: ${r1.written} (sizes, holes, drilled thickness, facts, weld) with source 'model'`, r1.applied && r1.written >= 15, JSON.stringify({ w: r1.written, k: r1.kept, d: r1.disagreements.length }));
  ok('the flange: 12115 long, 12 thick, 40 holes, drilled through 42 (the bolts\' grip at its splice)', (await stored(R.FL, 'LENGTH'))?.n === 12115 && (await stored(R.FL, 'LENGTH')).source === 'model'
    && (await stored(R.FL, 'THICKNESS'))?.n === 12 && (await stored(R.FL, 'HOLES'))?.n === 40 && (await stored(R.FL, 'HOLE_DRILL_THICKNESS'))?.n === 42,
  JSON.stringify(await Promise.all(['LENGTH', 'THICKNESS', 'HOLES', 'HOLE_DRILL_THICKNESS'].map((x) => stored(R.FL, x)))));
  ok('…its width a person typed (150, the same) is kept as typed', (await stored(R.FL, 'WIDTH'))?.source === 'entered' && r1.kept >= 1);
  ok('the gusset: 1606.49 × 1412.25 × 16, 142 holes, its true area from the model\'s outline', near((await stored(R.GUS, 'LENGTH'))?.n, 1606.49) && near((await stored(R.GUS, 'WIDTH'))?.n, 1412.25) && (await stored(R.GUS, 'HOLES'))?.n === 142
    && near((await stored(R.GUS, 'TRUE_AREA'))?.n, marksOfModel(rdso).get('U1-G1').shape.areaMm2, 0.01) && (await stored(R.GUS, 'TRUE_AREA')).source === 'model');
  ok('the angle: 450 long, 10 thick; no width from the model (a section) — the one a person typed stays', (await stored(R.ANG, 'LENGTH'))?.n === 450 && (await stored(R.ANG, 'THICKNESS'))?.n === 10 && (await stored(R.ANG, 'WIDTH'))?.source === 'entered');
  ok('the bent plate: thickness and holes, its flat size NOT guessed (listed as not derivable)', (await stored(R.BENT, 'THICKNESS'))?.n === 10 && (await stored(R.BENT, 'LENGTH')) === null
    && r1.notDerivable.some((x) => x.mark === 'U1-P2' && x.code === 'LENGTH'));
  ok('a row whose mark the model does not have: listed, nothing written', r1.notDerivable.some((x) => x.mark === MARK.ODD && /not in the model/.test(x.why)) && (await stored(R.ODD, 'LENGTH')) === null);
  const weld = weldLengths(rdso).get('BC1').mm / 1000;
  ok(`the chord's weld: its T-joints in the model, ${weld.toFixed(3)} m`, near((await stored(R.CHORD, 'MIG_WELD_LENGTH'))?.n, weld, 0.001) && (await stored(R.CHORD, 'MIG_WELD_LENGTH')).source === 'model');
  ok('the web\'s length a person typed (12000) is kept, and the model\'s 12115.53 is listed', (await stored(R.WEB, 'LENGTH'))?.n === 12000 && (await stored(R.WEB, 'LENGTH')).source === 'entered'
    && r1.disagreements.some((d) => d.recordId === R.WEB && d.code === 'LENGTH' && d.held === 12000 && near(d.model, 12115.53) && d.acceptable), JSON.stringify(r1.disagreements));
  const wt = await stored(R.FL, 'WEIGHT');
  ok(`the weights are worked out after the sizes (flange ${wt?.n} kg = 12115 × 150 × 12 × 7.85e-6), and roll up`, wt && near(wt.n, 12115 * 150 * 12 * 7850 / 1e9, 0.01) && (await stored(R.CHORD, 'WEIGHT'))?.n > 0, JSON.stringify(wt));
  ok('piece counts against the BOM are reported, not written (the angle: model 128, this BOM 32)', r1.pieces.some((p) => p.mark === 'BCA' && p.model === 128 && p.bom === 32) && !r1.pieces.some((p) => p.mark === 'BC1F1'), JSON.stringify(r1.pieces));
  ok(`open required values ${r1.openRequired.before} → ${r1.openRequired.after}`, r1.openRequired.after < r1.openRequired.before);
  ok('the run is kept', Number((await db.query("SELECT COUNT(*) n FROM cf_model_value_runs WHERE company_id = ? AND subject_type = 'line' AND subject_id = ?", [COMPANY, LINE]))[0][0].n) === 1);
  ok('the design signature does not move (a model value is not a design choice)', (await lineStandard(db, COMPANY, LINE)).edited === sigBefore.edited);

  const v1 = await readLineValues(db, COMPANY, LINE);
  ok('the Values screen: the model attached, a model value says so, the disagreement is listed', v1.model?.attached === true && cellOf(v1, R.FL, 'LENGTH')?.from === 'model' && !cellOf(v1, R.FL, 'LENGTH')?.waitingModel
    && v1.model.disagreements.length === 1 && v1.model.disagreements[0].code === 'LENGTH', JSON.stringify({ m: v1.model, c: cellOf(v1, R.FL, 'LENGTH') }));
  // Accept = the model's value written as the person's own.
  const dis = v1.model.disagreements[0];
  const acc = await writeLineValues(db, c, LINE, { writes: [{ recordId: dis.recordId, specCode: dis.code, value: dis.model }] });
  ok('accepting it writes the model\'s value as typed, and the list empties', (await stored(R.WEB, 'LENGTH'))?.n === 12115.53 && (await stored(R.WEB, 'LENGTH')).source === 'entered' && acc.view.model.disagreements.length === 0);

  console.log('\n  4. again, a new model, a person, a lock');
  const r2 = await applyModel(db, c, { lineId: LINE, bom });
  ok('a second run with the same model changes nothing', r2.written === 0 && r2.cleared === 0 && r2.values === 0 && r2.unchanged >= r1.written - 1, JSON.stringify({ w: r2.written, u: r2.unchanged, v: r2.values }));
  // A person types over a model value.
  await writeLineValues(db, c, LINE, { writes: [{ recordId: R.GUS, specCode: 'HOLES', value: 140 }] });
  // A new model: the flange 14 thick, the gusset's holes the same.
  const m2 = JSON.parse(text); m2.parts.BC1F1.t = 14; m2.parts['BC1F1#2'].t = 14;
  await attach(JSON.stringify(m2));
  const r3 = await applyModel(db, c, { lineId: LINE, bom });
  ok('a new model rewrites the model\'s own values (the flange now 14 thick)', (await stored(R.FL, 'THICKNESS'))?.n === 14 && (await stored(R.FL, 'THICKNESS')).source === 'model' && r3.written >= 1);
  ok('…and leaves what a person typed (the gusset\'s 140 holes), listed against the model\'s 142', (await stored(R.GUS, 'HOLES'))?.n === 140 && (await stored(R.GUS, 'HOLES')).source === 'entered'
    && r3.disagreements.some((d) => d.recordId === R.GUS && d.code === 'HOLES' && d.model === 142));
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [LINE]);
  await attach(text);
  const r4 = await applyModel(db, c, { lineId: LINE, bom });
  ok('a locked line: the differences are reported, nothing is written', r4.frozen === 'locked' && r4.written === 0 && r4.wouldWrite >= 1 && (await stored(R.FL, 'THICKNESS'))?.n === 14, JSON.stringify({ f: r4.frozen, w: r4.wouldWrite }));
  await db.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [LINE]);
  await applyModel(db, c, { lineId: LINE, bom });

  console.log('\n  5. the standard\'s version, and a line made from it');
  const saved = await saveLineToStandard(db, c, LINE, {});
  const versionId = saved.saved.versionId;
  // The version's model values are the line's (copied); clear them to compute them on the version itself.
  const [[ver]] = await db.query('SELECT root_item_id FROM cf_standard_drawing_versions WHERE id = ?', [versionId]);
  const vRows = (await db.query(`WITH RECURSIVE t AS (SELECT ? AS id UNION ALL SELECT l.child_id FROM t JOIN cf_boms b ON b.parent_id = t.id AND b.deleted_at IS NULL JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
                                   JOIN cf_item_details i ON i.master_id = l.child_id AND i.item_type = 'temporary') SELECT DISTINCT id FROM t`, [ver.root_item_id]))[0].map((r) => r.id);
  await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND subject_type = 'master' AND source = 'model' AND subject_id IN (?) AND deleted_at IS NULL", [COMPANY, vRows]);
  const rv = await applyModel(db, c, { versionId, bom });
  ok(`computed on the version: ${rv.written} values written`, rv.target.kind === 'version' && rv.written >= 15, JSON.stringify({ w: rv.written, s: rv.skipped }));
  const out = await addLineFromStandard(db, c, order.id, { standardId: std.id, quantity: 1 });
  const L2 = out.fromStandard.lineId;
  const R2 = rowMap(await rowsOf(L2));
  ok('a line made from the version carries the model\'s values, as they were', (await stored(R2.FL, 'LENGTH'))?.source === 'model' && (await stored(R2.FL, 'LENGTH')).n === 12115 && (await stored(R2.FL, 'HOLE_DRILL_THICKNESS'))?.n === 42);
  ok('…and the drawing refresh on the new line kept the model\'s facts (no part file there to say otherwise)', (await stored(R2.GUS, 'TRUE_AREA'))?.source === 'model');
  ok('…its required values are already filled where the model gives them', ((await readLineValues(db, COMPANY, L2)).counts.missingOwn) < r1.openRequired.before);

  console.log('\n  6. round trips');
  ok(`applying the model to a line is a fixed number of round trips (${run1.n}), not one per row`, run1.n <= 60, String(run1.n));

  await db.rollback();
} catch (err) {
  failed++;
  console.error(err);
  try { await db.rollback(); } catch { /* none */ }
} finally {
  db.release();
}
const after = await counts();
const moved = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
ok('rolled back: every cf_ table count as before', !moved.length, moved.map((m) => m.name).join(', '));
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
