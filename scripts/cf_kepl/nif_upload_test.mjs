/**
 * nif_upload_test.mjs — uploading a ProNest job (.nif) beside the DXFs (2026-10-13):
 * services/nestDxfImportService.js with lib/nifReader.js, on the shop's real jobs of
 * TM/NECL_48M_NESTING_NIF. Local only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nif_upload_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK, and every cf_ table is re-counted at the end. IT OWNS ITS FIXTURE:
 * its own grades, material, catalog plates, cut settings (one band per thickness, 3 mm kerf),
 * order, line, part rows, cut plates and drawings, every code tagged with a run id. The line's cut
 * pieces are made from the parts of the 16 mm, 12 mm and 10 mm jobs, the way an ERP line would
 * have them — its own codes (the shop's names are not ours), some drawing marks that stand in the
 * shop's names, two drawings with bolt holes the nesting does not cut, webs at the size on the
 * drawing (the nesting draws them wider, for camber), and a 9 mm packing nested on 10 mm plate.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const U = await imp('apps/cf_erp/services/nestDxfImportService.js');
const R = await imp('apps/cf_erp/services/nestRunService.js');
const DR = await imp('apps/cf_erp/services/partDrawingService.js');
const CNC = await imp('apps/cf_erp/services/cncExportService.js');
const RD = await imp('apps/cf_erp/lib/nestDxfReader.js');
const NIF = await imp('apps/cf_erp/lib/nifReader.js');
const PG = await imp('apps/cf_erp/services/partGeometry.js');
const { cutPlaces } = await imp('apps/cf_erp/lib/cutPlaces.js');
const D = await imp('scripts/cf_kepl/lib/nestDxfFixtures.mjs');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const DIR = path.resolve(BE, '../NECL_48M_NESTING_NIF');
const DENSITY = 7850;

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean (${String(name).slice(0, 60)})`);
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 900)}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + Number(f(x) ?? 0), 0);
const J = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

/** Counts the round trips made through it. */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (target, prop) => (prop === 'query' || prop === 'execute' ? (...args) => { tally.n += 1; return target[prop](...args); } : Reflect.get(target, prop)) });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
const c = { companyId: COMPANY, userId: null, userName: 'nif upload test' };

/* ───────────────────────────── the shop's files ───────────────────────────── */
const nifFile = (name) => { const buffer = fs.readFileSync(path.join(DIR, name)); return { filename: name, buffer, file: buffer.toString('base64'), doc: NIF.readNif(buffer, { filename: name }) }; };
const J10 = nifFile('10MM-NECL-PATNA.nif');
const J12 = nifFile('12MM-NECL-PATNA SPAN1.nif');
const J16 = nifFile('16MM-NECL-PATNA.nif');
const J20 = nifFile('20MM-NECL-PATNA.nif');
const J25 = nifFile('25MM-NECL-PATNA -SPAN1.nif');
const asReq = (f, extra = {}) => ({ filename: f.filename, file: f.file, ...extra });
/** The same job saved again: one byte of its settings text is another — nothing the nests are read from. */
function resaved(f) {
  const buffer = Buffer.from(f.buffer);
  const root = NIF._test.parseTree(buffer).root;
  const settings = root.kids[0].kids.find((k) => k.id === 1029);
  buffer[settings.start + 10 + 400] ^= 0x01;
  return { filename: f.filename, buffer, file: buffer.toString('base64') };
}

/* ───────────────────────────── the fixture ───────────────────────────── */
async function buildFixture(db) {
  const tag = `NF${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase()}`;
  const places = (await cutPlaces(db, COMPANY)).plate;
  if (!places.blanksNodeId || !places.stockNodeIds.length) throw new Error(`Company ${COMPANY} has no place set for plate cut pieces / raw plates (Setup › Cutting).`);
  const cutNode = places.blanksNodeId; const plateNode = Math.min(...places.stockNodeIds);
  const specByCode = async (code, dataType) => {
    const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
    if (s) return s.id;
    return (await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, code, code, dataType]))[0].insertId;
  };
  const spec = {};
  for (const [code, type] of [['THICKNESS', 'number'], ['LENGTH', 'number'], ['WIDTH', 'number'], ['GRADE', 'option'], ['MATERIAL', 'option'], ['DENSITY', 'number'], ['DRAWING_MARK', 'text'], ['CUT_LENGTH', 'number'], ['PIERCINGS', 'number']]) spec[code] = await specByCode(code, type);
  const option = async (specId, value) => (await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, 'active')", [COMPANY, specId, value]))[0].insertId;
  const GA = `${tag}-E350`; const GB = `${tag}-E250`;
  const grade = { A: await option(spec.GRADE, GA), B: await option(spec.GRADE, GB) };
  const mat = await option(spec.MATERIAL, `${tag}-STEEL`);
  const master = async ({ code, name, classificationId, itemType, ownerLineId = null, listPrice = null }) => {
    const [m] = await db.query("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, code, name, classificationId]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id, list_price, price_basis) VALUES (?, ?, ?, 'quantity', 'nos', ?, ?, ?, ?)",
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
  // Its own cut settings: one band per thickness (the narrowest band wins), 3 mm kerf — the kerf ProNest's common-line pairs are drawn apart.
  for (const t of [9, 10, 12, 16]) await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, t, t]);

  // Catalog plates, the sizes the shop buys. P16 comes in two grades: only the cut pieces' grade tells them apart.
  const plateSize = { P16: [16, 12000, 2300, 'A'], P16B: [16, 12000, 2300, 'B'], P12: [12, 12000, 2500, 'A'], P10: [10, 6000, 2000, 'A'], P9: [9, 6000, 2000, 'A'] };
  const plates = {};
  for (const [sfx, [t, l, w, g]] of Object.entries(plateSize)) {
    plates[sfx] = await master({ code: `${tag}-${sfx}`, name: `ProNest fixture plate ${sfx}`, classificationId: plateNode, itemType: 'catalog', listPrice: 62000 });
    await setVals(plates[sfx], steel(t, l, w, g));
  }
  const [node] = await db.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 0, 'item', ?, ?)", [COMPANY, `${tag}-PARTS`, `${tag} parts`]);
  const partNode = node.insertId;
  const [o] = await db.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, 'customer', 'ProNest upload fixture', 'confirmed')", [COMPANY, `${tag}-SO`]);
  const root = await master({ code: `${tag}-ROOT`, name: 'ProNest upload fixture girder', classificationId: partNode, itemType: 'temporary' });
  const [l] = await db.query("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, 'custom', ?, ?, 1, 1, NOW(), 1)", [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  /*
   * THE LINE'S CUT PIECES. sfx → [thickness, LENGTH, WIDTH, pieces, plate, drawing mark].
   * Marks in the shop's words stand in its part names (label); `Z…` marks do not (the ERP's own).
   */
  const parts = {
    // 16 mm job
    WEBA: [16, 6130, 2150, 8, 'P16', 'ZW-A'],                 // "WEB PL1 / PL5 -2150X6130", drawn 2275 wide: the size in the name
    WEBB1: [16, 11944, 2128, 6, 'P16', 'ZW-B1'],              // "WEB PL2 / PL3 / PL4 -2128X11944": two identical cut pieces, shared out
    WEBB2: [16, 11944, 2128, 6, 'P16', 'ZW-B2'],
    IS2P: [16, 2128, 424, 18, 'P16', "IS2'"],                 // a mark in the name
    IS1P: [16, 2128, 424, 26, 'P16', "IS1'"],
    IS1: [16, 2150, 424, 6, 'P16', 'EG1&IG1 IS1'],
    IS2: [16, 2150, 424, 6, 'P16', 'ZS-2'],                   // a DRAWING (the true outline + bolt holes), no label
    SPI: [16, 990, 225, 16, 'P16', 'SP1 TOP INNER PL'],
    SPO: [16, 990, 500, 8, 'P16', 'ZP-O'],                    // a DRAWING: the rectangle with 8 bolt holes
    CG: [16, 490, 350, 10, 'P16', 'ZC-G'],
    EDW: [16, 2484, 1660, 6, 'P16', 'ZE-W'],
    GS: [16, 550, 490, 9, 'P16', 'ZG-S'],
    GST: [16, 654, 200, 43, 'P16', 'ID GST PL1'],             // drawn 212.5 wide: its mark AND the size in its name
    PACK: [16, 125, 125, 144, 'P16', 'ZP-K'],                 // in the job, none nested
    // 12 mm job
    WSP: [12, 2000, 680, 32, 'P12', 'ZW-S'],
    BPK: [12, 880, 275, 16, 'P12', 'ZB-P'],                   // 14 of 16 nested
    TPK: [12, 490, 225, 16, 'P12', 'ZT-P'],                   // 3 of 16 nested
    EDC: [12, 1400, 380, 24, 'P12', 'ZE-C'],
    ST1: [12, 2100, 140, 52, 'P12', 'ZS-T1'],
    ST2: [12, 2078, 140, 132, 'P12', 'ZS-T2'],
    // 10 mm job: a 9 mm packing, nested on 10 mm plate
    COV: [9, 1400, 185, 24, 'P9', 'ZC-V'],
    // on the DXF plate
    DX: [10, 500, 300, 2, 'P10', 'ZD-X'],
    // a 25 mm cut piece that has, as its DRAWING, the very outline of the 12 mm stiffener: the wrong thickness must not win
    ST25: [25, 2100, 140, 4, 'P16', 'ZS-25'],
  };
  const cut = {}; const partRow = {}; const plateLine = {}; const mark = {};
  let n = 0;
  const addPart = async (sfx, [t, len, wid, qty, plateSfx, m]) => {
    n += 1;
    mark[sfx] = m.startsWith('Z') ? `${tag}-${m}` : m;
    const row = await master({ code: `${tag}-PT-${sfx}`, name: `ProNest fixture part ${sfx}`, classificationId: partNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(row, [[spec.THICKNESS, num(t)], [spec.LENGTH, num(len)], [spec.WIDTH, num(wid)], [spec.DENSITY, num(DENSITY)], [spec.DRAWING_MARK, { t: mark[sfx] }]]);
    const cp = await master({ code: `${tag}-C${sfx}`, name: `ProNest fixture cut plate ${sfx}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(cp, steel(t, len, wid, 'A'));
    await bomLine(root, row, qty, n);
    await bomLine(row, cp, 1, 1);
    const [, pl, pw] = plateSize[plateSfx];
    plateLine[sfx] = await bomLine(cp, plates[plateSfx], (len * wid) / (pl * pw), 1);
    cut[sfx] = cp; partRow[sfx] = row;
  };
  for (const [sfx, def] of Object.entries(parts)) await addPart(sfx, def);
  /** A catalog plate and cut pieces added after the fixture was built (and a cut-settings band for a new thickness). */
  const addPlate = async (sfx, [t, l, w, g]) => {
    plateSize[sfx] = [t, l, w, g];
    plates[sfx] = await master({ code: `${tag}-${sfx}`, name: `ProNest fixture plate ${sfx}`, classificationId: plateNode, itemType: 'catalog', listPrice: 62000 });
    await setVals(plates[sfx], steel(t, l, w, g));
    await db.query('INSERT INTO cf_cut_settings (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, seq_gap_min_mm, seq_gap_max_mm, order_margin_length_mm, order_margin_width_mm, order_step_mm, guillotine) VALUES (?, ?, ?, 3, 5, 8, 100, 50, 50, 0)', [COMPANY, t, t]);
  };
  const addParts = async (more) => { for (const [sfx, def] of Object.entries(more)) { parts[sfx] = def; await addPart(sfx, def); } };
  const fx = {
    addPlate, addParts, tag, GA, GB, lineId, orderId: o.insertId, spec, plates, parts, cut, partRow, plateLine, mark, code: (sfx) => `${tag}-C${sfx}`, plateCode: (sfx) => `${tag}-${sfx}`, sfxOfCut: (id) => Object.keys(cut).find((k) => Number(cut[k]) === Number(id)) ?? null };

  // Two drawings, as an upload would file them, each with BOLT HOLES the nesting does not cut.
  const drawing = async (sfx, loops) => {
    const text = D.shapeToPartDxf({ name: sfx, loops });
    const g = PG.readPartDrawing(text).geometry;
    await db.query(
      `INSERT INTO cf_part_drawings (company_id, order_line_id, mark, mark_norm, file_name, file_kind, length_mm, width_mm, area_mm2, cut_length_mm, piercings, holes, inner_cuts, geometry_json, dxf_text)
       VALUES (?, ?, ?, ?, ?, 'dxf', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [COMPANY, lineId, mark[sfx], DR.normMark(mark[sfx]), `${mark[sfx]}.dxf`, g.lengthMm, g.widthMm, g.areaMm2, g.cutLengthMm, g.piercings, g.holes, g.innerCuts, JSON.stringify(g), text],
    );
    return g;
  };
  // SPO: 990 × 500 with eight Ø26 holes.
  fx.drawnSPO = await drawing('SPO', [{ v: [[0, 0], [990, 0], [990, 500], [0, 500]] }, ...[150, 380, 610, 840].flatMap((x) => [120, 380].map((y) => ({ circle: [x, y, 13] })))]);
  // IS2: the stiffener's TRUE outline — taken from the job itself, laid at the origin — with three Ø26 holes along it.
  {
    const p = J16.doc.nests.flatMap((nest) => nest.parts).find((q) => /IS2-424X2150/.test(q.name) && !q.mirrored && Math.abs(q.rotationDeg % 180) < 1e-6) ?? J16.doc.nests.flatMap((nest) => nest.parts).find((q) => /IS2-424X2150/.test(q.name) && !q.mirrored);
    const out = p.rings.outline.map(([x, y]) => [x - p.bbox.x, y - p.bbox.y]);
    const inside = (pt) => { let cIn = false; for (let i = 0, j = out.length - 1; i < out.length; j = i++) { const [xi, yi] = out[i]; const [xj, yj] = out[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) cIn = !cIn; } return cIn; };
    const clear = (pt) => inside(pt) && [[40, 0], [-40, 0], [0, 40], [0, -40], [28, 28], [-28, 28], [28, -28], [-28, -28]].every(([dx, dy]) => inside([pt[0] + dx, pt[1] + dy]));
    const tall = p.bbox.width > p.bbox.length;
    const holes = [];
    for (const f of [0.25, 0.5, 0.75]) {
      for (const g of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const pt = tall ? [p.bbox.length * g, p.bbox.width * f] : [p.bbox.length * f, p.bbox.width * g];
        if (clear(pt)) { holes.push({ circle: [pt[0], pt[1], 13] }); break; }
      }
    }
    fx.is2Holes = holes.length;
    fx.drawnIS2 = await drawing('IS2', [{ v: out }, ...holes]);
  }
  // ST25: the 12 mm job's sniped stiffener, as the drawing of a 25 mm cut piece.
  {
    const p = J12.doc.nests.flatMap((nest) => nest.parts).find((q) => /PLAIN STFR PL1-140X2100/.test(q.name));
    await drawing('ST25', [{ v: p.rings.outline.map(([x, y]) => [x - p.bbox.x, y - p.bbox.y]) }]);
  }
  return fx;
}

/* ───────────────────────────── helpers on the fixture ───────────────────────────── */
let fx = null;
const upload = (files, opts = {}, db = conn) => U.uploadNestFiles(db, c, fx.lineId, { files, ...opts });
const liveLots = async () => (await conn.query("SELECT * FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate' ORDER BY lot_no", [COMPANY, fx.lineId]))[0];
const liveFiles = async () => (await conn.query('SELECT id, file_name, file_kind, file_hash, byte_size, nest_no, CHAR_LENGTH(file_text) AS chars FROM cf_nest_files WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY, fx.lineId]))[0];
const byRule = (answer) => { const m = {}; for (const f of answer.files) for (const k of f.copies ?? [{ counts: f.counts }]) for (const p of f.placements) { void k; m[p.by] = (m[p.by] ?? 0) + 1; } return m; };
const sfxCounts = (list) => Object.fromEntries(list.map((x) => [fx.sfxOfCut(x.cutPlateId), x.qty]).sort());
const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };
/** Every saved piece of a job's plates is the job's own outline, where the job has it: the worst distance between the two. */
async function worstDeviation(job, prefix) {
  const view = await N.getNesting(conn, COMPANY, fx.lineId);
  const nests = view.groups.flatMap((g) => g.nests);
  let worst = 0; let pieces = 0; let missing = 0; let other = 0;
  for (const nest of job.doc.nests) {
    for (let k = 1; k <= nest.quantity; k += 1) {
      const lotNo = `${prefix}-N${String(nest.nestNo).padStart(2, '0')}${nest.quantity > 1 ? `-${k}` : ''}`;
      const saved = nests.find((x) => x.lotNo.toUpperCase() === lotNo.toUpperCase());
      if (!saved) { missing += nest.parts.length; continue; }
      const left = saved.pieces.slice();
      for (const p of nest.parts) {
        const i = left.findIndex((q) => Math.abs(q.x - p.bbox.x) <= 0.01 && Math.abs(q.y - p.bbox.y) <= 0.01 && Math.abs(q.length - p.bbox.length) <= 0.01);
        if (i < 0) { missing += 1; continue; }
        const [q] = left.splice(i, 1);
        pieces += 1;
        if (q.shapeFrom !== 'nesting file' || q.placedBy !== 'customer' || !q.rings) other += 1;
        else worst = Math.max(worst, RD.ringsDeviation([q.rings.outline], [p.rings.outline]));
      }
      missing += left.length;
    }
  }
  return { worst, pieces, missing, other, nests };
}
const identityGap = (nests) => Math.max(0, ...nests.map((n) => Math.abs(n.usedArea + sum(Object.values(n.waste)) - n.sheetArea)));

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  section('Fixture');
  fx = await buildFixture(conn);
  const need = Object.fromEntries(Object.entries(fx.parts).map(([k, p]) => [k, p[3]]));
  console.log(`  ${fx.tag}: line ${fx.lineId}, ${Object.keys(fx.cut).length} cut plates, ${sum(Object.values(need))} pieces`);
  {
    const ctx = await N.importContext(conn, COMPANY, fx.lineId);
    ok('the fixture is the line the upload sees: every cut plate with its quantity and its steel', Object.entries(fx.cut).every(([sfx, id]) => { const cp = ctx.cutPlates.find((x) => x.id === id); return cp?.pieces === need[sfx] && cp.steel.thickness === fx.parts[sfx][0]; }));
    const facts = await DR.drawingFactsOfLine(conn, COMPANY, fx.lineId);
    ok(`two cut plates have a drawing with bolt holes (SP outer: 8 holes; the stiffener: its true outline and ${fx.is2Holes} holes); a third is the 25 mm one`, [...facts.values()].filter((f) => f.rings).length === 3 && fx.drawnSPO.holes === 8 && fx.drawnIS2.holes === fx.is2Holes && fx.is2Holes >= 2, J([[...facts.values()].filter((f) => f.rings).length, fx.drawnSPO.holes, fx.drawnIS2.holes]));
  }

  /* ───────────── 1. the 12 mm job: four nests ───────────── */
  let trips = {};
  section('1. The 12 mm job (4 nests, 257 pieces) — preview');
  {
    const t = counting(conn);
    const dry = await upload([asReq(J12)], {}, t.db);
    trips.preview12 = t.tally.n;
    ok('one file sent, one files[] entry PER NEST — each says its job, its nest, its quantity, the program and the version', dry.files.length === 4 && dry.files.every((f, i) => f.sourceKind === 'pronest' && f.sourceFile === J12.filename && f.jobName === '12MM-NECL-PATNA' && f.jobNestNo === i + 1 && f.jobNests === 4 && f.nestQuantity === 1 && f.program === 'ProNest LT' && f.version === '16.2.1.9298' && f.filename === `${J12.filename} nest ${i + 1}`), J(dry.files.map((f) => [f.filename, f.sourceKind, f.jobNestNo, f.nestQuantity])));
    ok('lot numbers are the job\'s — 12MM-NECL-PATNA-N01 … N04 — one plate each (lotNos, copies)', J(dry.files.map((f) => f.lotNo)) === J(['12MM-NECL-PATNA-N01', '12MM-NECL-PATNA-N02', '12MM-NECL-PATNA-N03', '12MM-NECL-PATNA-N04']) && dry.files.every((f) => J(f.lotNos) === J([f.lotNo]) && f.copies.length === 1 && f.copies[0].copy === 1 && f.copies[0].action === 'add' && f.nestNo === f.lotNo && f.copy === undefined), J(dry.files.map((f) => [f.lotNo, f.lotNos, f.copies])));
    ok('the preview is clean: no problem, no warning, nothing to force, nothing written', dry.dryRun === true && dry.applied === false && dry.canSave === true && dry.needsForce === false && dry.problems.length === 0 && dry.warnings.length === 0 && (await liveLots()).length === 0, J([dry.problems, dry.warnings]));
    ok('every piece of every nest is recognised: 37 / 84 / 99 / 37, all by the size of their outline', J(dry.files.map((f) => [f.parts, f.placed])) === J([[37, 37], [84, 84], [99, 99], [37, 37]]) && dry.files.every((f) => f.status === 'ok' && f.placements.every((p) => p.by === 'size')), J(dry.files.map((f) => [f.parts, f.placed, f.status, byRule({ files: [f] })])));
    ok('the plate is found by the size the job draws (2500 × 12000, standing as ProNest has it), the thickness the job states, and the grade of the cut pieces', dry.files.every((f) => f.plate.code === fx.plateCode('P12') && f.plate.length === 2500 && f.plate.width === 12000 && f.plate.thickness === 12 && f.plate.grade === fx.GA && f.plate.drawn === true && f.plate.resolvedBy === 'size' && f.plate.kerfMm === 3 && f.units === 'in'), J(dry.files[0].plate));
    ok('every placement carries the NESTED outline (shapeFrom "nesting file"), the shop\'s part name, and its steel', dry.files.every((f) => f.placements.every((p) => p.shapeFrom === 'nesting file' && p.rings.outline.length >= 4 && p.placedBy === 'customer' && /^1[12]MM-/.test(p.partName) && Math.abs(p.area - area(p.rings.outline)) < 1)), J(dry.files[0].placements[0]));
    ok('THICKNESS decides before shape: the 52 stiffeners are the 12 mm cut piece (found by size) — not the 25 mm one whose DRAWING is their very outline', dry.files.flatMap((f) => f.placements).filter((p) => p.cutPlateId === fx.cut.ST1).length === 52 && !dry.files.flatMap((f) => f.placements).some((p) => p.cutPlateId === fx.cut.ST25) && !dry.problemList.some((x) => x.code === 'PART_WRONG_THICKNESS'), J(dry.problemList.slice(0, 2)));
    const st = dry.files.flatMap((f) => f.placements).find((p) => p.cutPlateId === fx.cut.ST1);
    ok(`a stiffener with no drawing keeps its sniped outline: ${st.rings.outline.length} corners, ${Math.round(st.area)} mm² against the 294,000 of its rectangle`, st.rings.outline.length > 4 && st.area < 290000 && st.area > 280000);
    ok('nothing is "too close" or "in the rim": ProNest keeps 5 mm, and its common-line pairs are 3 mm apart — our kerf here', !dry.warningList.some((w) => w.code === 'TOO_CLOSE' || w.code === 'IN_RIM'), J(dry.warnings));
    // With a WIDER kerf of ours (4 mm) the common-line pairs are closer than it: one cut between two pieces, as meant — a note.
    await conn.query('UPDATE cf_cut_settings SET kerf_mm = 4 WHERE company_id = ? AND thickness_min_mm = 12 AND thickness_max_mm = 12 AND deleted_at IS NULL', [COMPANY]);
    const wide = await upload([asReq(J12)]);
    await conn.query('UPDATE cf_cut_settings SET kerf_mm = 3 WHERE company_id = ? AND thickness_min_mm = 12 AND thickness_max_mm = 12 AND deleted_at IS NULL', [COMPANY]);
    ok('cut with a 4 mm kerf of ours, the common-line pairs (3 mm apart) are a NOTE, not TOO_CLOSE — one cut between the two', wide.files.every((f) => f.plate.kerfMm === 4 && f.notes.some((s) => /pairs? of pieces (is|are) cut on a common line in ProNest \(drawn 3( – 3\.\d+)? mm apart\): one cut between the two, so being closer than our 4 mm kerf is as meant\./.test(s))) && !wide.warningList.some((w) => w.code === 'TOO_CLOSE') && wide.canSave === true && wide.needsForce === false, J([wide.files.map((f) => [f.plate.kerfMm, f.notes]), wide.problems, wide.canSave, wide.needsForce]));
    const job = dry.jobs[0];
    ok('jobs[]: one line for the job — 4 nests, 4 plates, 6 parts, 257 pieces placed, 257 matched (all by size)', dry.jobs.length === 1 && job.filename === J12.filename && job.sourceKind === 'pronest' && job.status === 'ok' && job.program === 'ProNest LT' && job.version === '16.2.1.9298' && job.jobName === '12MM-NECL-PATNA' && job.lotPrefix === '12MM-NECL-PATNA' && job.nests === 4 && job.plates === 4 && job.parts === 6 && job.placed === 257 && job.matched === 257 && J(job.matchedBy) === J({ size: 257 }) && job.bytes === J12.buffer.length, J({ ...job, notes: undefined }));
    ok('jobs[].notNested says what the JOB left un-nested, in the shop\'s names: 14 of 16 and 3 of 16', J(job.notNested) === J([{ name: '11MM-SP1 BTM PACK PL-275X880- 16', required: 16, nested: 14, notNested: 2 }, { name: '11MM-SP1 TOP PACK PL-225X490- 16', required: 16, nested: 3, notNested: 13 }]), J(job.notNested));
    const left = Object.fromEntries(dry.leftOver.map((x) => [fx.sfxOfCut(x.cutPlateId), x.qty]));
    ok('leftOver (the line\'s own, unchanged) says the same in cut plates: 2 and 13 of the packs — and everything the other jobs will bring', left.BPK === 2 && left.TPK === 13 && left.WSP === undefined && left.ST2 === undefined && left.WEBA === 8 && left.COV === 24, J(left));
    ok('the diff: 4 plates added, nothing else', dry.diff.added.length === 4 && dry.diff.replaced.length === 0 && dry.diff.removed.length === 0 && sum(dry.diff.added, (a) => a.pieces) === 257 && dry.totals.plates === 4 && dry.totals.uploadedPlates === 4);
    ok('the message counts the file and what is in it', /^1 file read \(1 ProNest job: 4 nests, 4 plates\); plates: 4 added/.test(dry.message), dry.message);
  }

  section('2. The 12 mm job — saved');
  let prefix12 = '12MM-NECL-PATNA';
  {
    const t = counting(conn);
    const saved = await upload([asReq(J12)], { dryRun: false }, t.db);
    trips.save12 = t.tally.n;
    ok('saved: 4 plates, 257 pieces, every entry with its lotId (and one in copies[])', saved.applied === true && saved.saved.lots === 4 && saved.saved.pieces === 257 && saved.files.length === 4 && saved.files.every((f) => Number.isInteger(f.lotId) && f.copies[0].lotId === f.lotId), J(saved.saved ?? saved.message));
    const lots = await liveLots(); const files = await liveFiles();
    ok('every lot is imported, laid out by the customer, source "pronest", from the .nif — and all four point at ONE stored file', lots.length === 4 && lots.every((l) => l.origin === 'imported' && l.layout_origin === 'customer' && l.source_kind === 'pronest' && l.source_file === J12.filename && l.source_hash?.length === 64 && l.check_verdict === 'fits' && !l.forced) && new Set(lots.map((l) => l.nest_file_id)).size === 1 && new Set(lots.map((l) => l.source_hash)).size === 4);
    ok(`the job is stored once, as base64 in the existing column (${files[0]?.chars} characters for ${J12.buffer.length} bytes), kind "pronest", under the job's name`, files.length === 1 && files[0].file_kind === 'pronest' && files[0].file_name === J12.filename && Number(files[0].byte_size) === J12.buffer.length && files[0].nest_no === '12MM-NECL-PATNA' && Number(files[0].chars) === Math.ceil(J12.buffer.length / 3) * 4);
    const dl1 = await U.nestFileOf(conn, COMPANY, fx.lineId, lots[0].id); const dl4 = await U.nestFileOf(conn, COMPANY, fx.lineId, lots[3].id);
    ok('"download the customer\'s file" gives the .nif back byte for byte, from any of its plates', dl1.filename === J12.filename && dl1.contentType === 'application/octet-stream' && dl1.buffer.equals(J12.buffer) && dl4.buffer.equals(J12.buffer));
    const dev = await worstDeviation(J12, prefix12);
    ok(`every stored piece is the job's own outline where the job has it (worst ${dev.worst.toFixed(4)} mm over ${dev.pieces} pieces)`, dev.pieces === 257 && dev.missing === 0 && dev.other === 0 && dev.worst <= 0.01, J({ pieces: dev.pieces, missing: dev.missing, other: dev.other }));
    ok(`parts + waste by cause = the plate, on every plate (worst ${identityGap(dev.nests).toFixed(4)} mm²)`, identityGap(dev.nests) <= 1);
    ok('GET …/nesting: the plates say sourceKind "pronest", the job\'s file, a customer layout — and none is stale', dev.nests.length === 4 && dev.nests.every((n) => n.sourceKind === 'pronest' && n.sourceFile === J12.filename && n.layoutOrigin === 'customer' && !n.stale && n.verdict === 'fits'), J(dev.nests.map((n) => [n.sourceKind, n.stale, n.verdict])));
    const list = await U.getNestFiles(conn, COMPANY, fx.lineId);
    ok('GET …/nesting/files: limits.kinds has "nif"; each plate names the job file (kind "pronest")', J(list.limits.kinds) === J(['dxf', 'nif']) && list.limits.maxPlates === 600 && list.plates.length === 4 && list.plates.every((p) => p.sourceKind === 'pronest' && p.file?.kind === 'pronest' && p.file.filename === J12.filename && p.file.bytes === J12.buffer.length));
    const q = saved.saved.quantities.filter((x) => x.basis === 'nesting plan');
    ok('the plate quantity of the six nested cut plates is worked out from the nesting, on the 12 mm plate', q.length === 6 && q.every((x) => x.applied && x.plateCode === fx.plateCode('P12') && x.quantity > 0), J(saved.saved.quantities.map((x) => [fx.sfxOfCut(x.cutPlateId), x.basis, x.plateCode, x.applied])));
    ok('cut length and piercings are worked out for the nested cut plates', saved.saved.cuts.nested === 6, J(saved.saved.cuts));
  }

  section('3. The same job again — a re-upload replaces, it does not duplicate');
  {
    let out = await upload([asReq(J12)]);
    ok('the same bytes: all four plates "unchanged", nothing to save', out.files.every((f) => f.action === 'unchanged' && f.copies[0].action === 'unchanged') && out.diff.unchanged.length === 4 && out.diff.added.length === 0 && out.canSave === false, J([out.files.map((f) => f.action), out.message]));
    const again = resaved(J12);
    ok('(the job saved again by ProNest — another file, the same nests — still reads)', NIF.readNif(again.buffer).counts.placements === 257 && !again.buffer.equals(J12.buffer));
    out = await upload([asReq(again)]);
    ok('the job saved again: 4 plates REPLACED, none added, the pieces all where they were', out.diff.replaced.length === 4 && out.diff.added.length === 0 && out.diff.removed.length === 0 && out.files.every((f) => f.action === 'replace') && out.diff.replaced.every((r) => r.moved === 0 && r.added === 0 && r.removed === 0) && out.canSave === true, J(out.diff.replaced.map((r) => [r.lotNo, r.moved, r.added, r.removed])));
    // A plate of an EARLIER upload of this job that the job no longer makes (a ninth nest, say).
    const [lotRows] = await conn.query("SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND lot_no = '12MM-NECL-PATNA-N04'", [COMPANY, fx.lineId]);
    await conn.query("UPDATE cf_plate_lots SET lot_no = '12MM-NECL-PATNA-N09' WHERE id = ?", [lotRows[0].id]);
    out = await upload([asReq(again)]);
    ok('a plate saved from an earlier upload of the job that the job no longer has is REMOVED with it (merge mode too), and says why', out.diff.removed.length === 1 && out.diff.removed[0].lotNo === '12MM-NECL-PATNA-N09' && /no longer has this plate/.test(out.diff.removed[0].because) && out.diff.replaced.length === 3 && out.diff.added.length === 1 && out.surplus.length === 0 && !out.needsForce, J([out.diff.removed, out.diff.added.map((a) => a.lotNo), out.surplus]));
    const saved = await upload([asReq(again)], { dryRun: false });
    const lots = await liveLots(); const files = await liveFiles();
    ok('saved: still four plates N01 … N04, 257 pieces, ONE stored file (the new one; the old one went with its last plate)', saved.applied === true && J(lots.map((l) => l.lot_no)) === J(['12MM-NECL-PATNA-N01', '12MM-NECL-PATNA-N02', '12MM-NECL-PATNA-N03', '12MM-NECL-PATNA-N04']) && files.length === 1 && new Set(lots.map((l) => l.nest_file_id)).size === 1 && lots[0].nest_file_id === files[0].id && saved.saved.pieces === 257 && saved.saved.removedLots === 4, J([lots.map((l) => l.lot_no), files.length, saved.saved]));
    const dev = await worstDeviation(J12, prefix12);
    ok('…and they are the job\'s nests', dev.pieces === 257 && dev.missing === 0 && dev.worst <= 0.01);
  }

  /* ───────────── 4. the 16 mm job ───────────── */
  section('4. The 16 mm job (11 nests, three of them ×4: 20 plates, 168 pieces) — the ladder');
  let dry16 = null;
  {
    const t = counting(conn);
    dry16 = await upload([asReq(J16)], {}, t.db);
    trips.preview16 = t.tally.n;
    const fs16 = dry16.files;
    ok('eleven files[] entries for eleven nests; quantities 4 4 4 1 … 1', fs16.length === 11 && J(fs16.map((f) => f.nestQuantity)) === J([4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1]) && fs16.every((f, i) => f.jobNestNo === i + 1 && f.jobNests === 11));
    ok('a nest cut ×4 is FOUR plates: lotNos …-N01-1 … -4, copies[] one per plate, and a note saying so', J(fs16[0].lotNos) === J(['16MM-NECL-PATNA-N01-1', '16MM-NECL-PATNA-N01-2', '16MM-NECL-PATNA-N01-3', '16MM-NECL-PATNA-N01-4']) && fs16[0].copies.length === 4 && J(fs16[0].copies.map((k) => k.copy)) === J([1, 2, 3, 4]) && fs16[0].lotNo === '16MM-NECL-PATNA-N01-1' && fs16[0].nestNo === '16MM-NECL-PATNA-N01-1' && fs16[0].notes.some((s) => /cuts this nest on 4 identical plates/.test(s)) && fs16[3].lotNo === '16MM-NECL-PATNA-N04' && fs16[3].copies.length === 1, J([fs16[0].lotNos, fs16[0].notes, fs16[3].lotNo]));
    ok('the diff and the totals are in PLATES: 20 added, 168 pieces', dry16.diff.added.length === 20 && sum(dry16.diff.added, (a) => a.pieces) === 168 && dry16.totals.uploadedPlates === 24 && dry16.jobs[0].nests === 11 && dry16.jobs[0].plates === 20 && dry16.jobs[0].parts === 16 && dry16.jobs[0].placed === 168 && dry16.jobs[0].matched === 168, J([dry16.diff.added.length, dry16.totals, { ...dry16.jobs[0], notes: 0 }]));
    ok('nothing blocks and nothing needs force', dry16.canSave === true && dry16.needsForce === false && dry16.problems.length === 0 && dry16.warnings.length === 0, J([dry16.problems, dry16.warnings]));
    console.log(`        matched by: ${J(dry16.jobs[0].matchedBy)}`);
    const all = fs16.flatMap((f) => f.placements.map((p) => ({ ...p, sfx: fx.sfxOfCut(p.cutPlateId), nest: f.jobNestNo })));
    const rule = (sfx) => [...new Set(all.filter((p) => p.sfx === sfx).map((p) => p.by))].join('+');
    // (a) label
    ok('rung a — LABEL: a drawing mark standing in the shop\'s name ("…IS1\'-424X2128…", "…SP1 TOP INNER PL-…", "…EG1&IG1 IS1-…") names the cut piece', rule('IS1P') === 'label' && rule('IS2P') === 'label' && rule('SPI') === 'label' && rule('IS1') === 'label', J(['IS1P', 'IS2P', 'SPI', 'IS1'].map(rule)));
    ok('…and it is the mark that tells IS1\' from IS2\' — the two are the same size, 26 and 18 pieces', dry16.coverage.find((x) => x.cutPlateId === fx.cut.IS1P).nested === 26 && dry16.coverage.find((x) => x.cutPlateId === fx.cut.IS2P).nested === 18);
    // (b) shape
    const spo = all.filter((p) => p.sfx === 'SPO'); const is2 = all.filter((p) => p.sfx === 'IS2');
    ok('rung b — TRUE OUTLINE: a cut piece with a drawing is matched by its outline although the drawing has bolt holes the nesting has not (8 + 6 pieces)', rule('SPO') === 'shape' && rule('IS2') === 'shape' && spo.length === 8 && is2.length === 6, J([rule('SPO'), rule('IS2'), spo.length, is2.length]));
    ok('…what is stored for them is the NESTED outline — no holes — and its steel is the outline\'s (990 × 500 = 495,000 mm², not less eight holes)', [...spo, ...is2].every((p) => p.shapeFrom === 'nesting file' && p.rings.holes.length === 0 && p.rings.cutouts.length === 0) && spo.every((p) => Math.abs(p.area - 495000) < 5) && fs16.some((f) => f.notes.some((s) => /ha(s|ve) a drawing and (is|are) stored as the nesting file's outline all the same/.test(s))), J([spo[0]?.area, spo[0]?.rings.holes.length]));
    ok(`…the one stiffener ProNest nested MIRRORED is found as its part by its outline, flipped (${is2.filter((p) => p.mirrored).length} of the 6 placements say mirrored)`, is2.length === 6 && J16.doc.counts.mirrored === 1 && is2.filter((p) => p.mirrored).length === 1, J(is2.map((p) => [p.nest, p.rotationDeg, p.mirrored])));
    // (c) size
    ok('rung c — SIZE: plain plates with no mark and no drawing are found by the size of their outline', rule('CG') === 'size' && rule('EDW') === 'size' && rule('GS') === 'size', J(['CG', 'EDW', 'GS'].map(rule)));
    // (d) name size
    const webA = all.filter((p) => p.sfx === 'WEBA');
    ok('rung d — NAME SIZE: the cambered webs "…-2150X6130" are drawn 2275 wide; neither outline nor box is the cut piece, the size in the name is — by "name size", with outlineDiffers', webA.length === 8 && rule('WEBA') === 'name size' && webA.every((p) => J(p.outlineDiffers?.cutPiece) === J([6130, 2150]) && Math.abs(p.outlineDiffers.drawn[0] - 6130) < 3 && Math.abs(p.outlineDiffers.drawn[1] - 2275) < 2 && p.confidence === 0.4), J([rule('WEBA'), webA[0]?.outlineDiffers, webA[0]?.confidence]));
    const note = fs16.flatMap((f) => f.notes).find((s) => s.startsWith(`${fx.code('WEBA')} (`));
    ok('…with a note saying how much the nested outline differs, and that it is what is stored', /was matched by the size in its name: it is drawn 6130 × 227\d(\.\d+)?, the cut piece is 6130 × 2150 — the nesting's outline is another size \(camber, or an allowance for cutting\)\. The nested outline is what is cut/.test(note ?? ''), note);
    ok('…the web keeps its cambered outline (arcs as corners) and its true steel — more than 6130 × 2150', webA.every((p) => p.shapeFrom === 'nesting file' && p.rings.outline.length > 20 && p.area > 6130 * 2150 && Math.abs(p.area - 13181792) < 200), J([webA[0]?.rings.outline.length, webA[0]?.area]));
    const gst = all.filter((p) => p.sfx === 'GST');
    ok('…a part with its mark AND its size in the name, drawn 212.5 wide for a 200 cut piece, is taken by its label (43 pieces), saying how it differs', gst.length === 43 && rule('GST') === 'label' && gst.every((p) => J(p.outlineDiffers?.cutPiece) === J([654, 200]) && p.confidence === 0.6), J([gst.length, rule('GST'), gst[0]?.outlineDiffers]));
    // (e) quantity
    const webB = all.filter((p) => p.sfx === 'WEBB1' || p.sfx === 'WEBB2');
    const perCopy = fs16.slice(0, 3).flatMap((f) => f.copies.map((k) => sfxCounts(k.counts)));
    ok('rung e — QUANTITY: the long webs could be either of two identical cut pieces (same size in the name); the 12 plates are shared out 6 and 6, plate by plate', perCopy.length === 12 && perCopy.filter((x) => x.WEBB1 === 1).length === 6 && perCopy.filter((x) => x.WEBB2 === 1).length === 6 && webB.every((p) => p.by === 'quantity' && p.alternatives?.length === 1) && dry16.coverage.find((x) => x.cutPlateId === fx.cut.WEBB1).nested === 6 && dry16.coverage.find((x) => x.cutPlateId === fx.cut.WEBB2).nested === 6, J(perCopy));
    ok('the rungs add up to the 168 pieces', sum(Object.values(dry16.jobs[0].matchedBy)) === 168 && dry16.jobs[0].matchedBy['name size'] === 8 && dry16.jobs[0].matchedBy.quantity === 12 && dry16.jobs[0].matchedBy.shape === 14 && dry16.jobs[0].matchedBy.label === 109 && dry16.jobs[0].matchedBy.size === 25, J(dry16.jobs[0].matchedBy));
    // marking, grade, not nested
    ok('the closed letters of the webs\' marking text are never cut-outs and raise nothing (no MARKING_UNSURE, no CUTOUTS_FROM_FILE)', all.every((p) => p.rings.cutouts.length === 0) && !dry16.warningList.length && J16.doc.notes.some((s) => /marking/.test(s)) && dry16.jobs[0].notes.some((s) => /scribed letters, read as marking/.test(s)));
    ok('GRADE: the job says only "MS" — of the two 2300 × 12000 × 16 catalog plates the one in the cut pieces\' grade is taken', fs16.every((f) => f.plate.code === fx.plateCode('P16') && f.plate.grade === fx.GA && f.plate.thickness === 16));
    ok('notNested: the 144 packs the job holds and has not nested — and leftOver says the same of the line', J(dry16.jobs[0].notNested) === J([{ name: '16MM-ID PACK PL2-125X125- 144', required: 144, nested: 0, notNested: 144 }]) && dry16.leftOver.find((x) => x.cutPlateId === fx.cut.PACK)?.qty === 144, J(dry16.jobs[0].notNested));

    const t2 = counting(conn);
    const saved = await upload([asReq(J16)], { dryRun: false }, t2.db);
    trips.save16 = t2.tally.n;
    const lots = (await liveLots()).filter((l) => l.lot_no.startsWith('16MM'));
    ok('saved: 20 plates, 168 pieces, all of one stored file; each entry\'s copies[] carries its lotId', saved.applied === true && saved.saved.lots === 20 && saved.saved.pieces === 168 && lots.length === 20 && new Set(lots.map((l) => l.nest_file_id)).size === 1 && saved.files[0].copies.every((k) => Number.isInteger(k.lotId)) && new Set(saved.files[0].copies.map((k) => k.lotId)).size === 4 && (await liveFiles()).length === 2, J(saved.saved ?? saved.message));
    const dev = await worstDeviation(J16, '16MM-NECL-PATNA');
    ok(`every stored piece of the 20 plates is the job's own outline where the job has it (worst ${dev.worst.toFixed(4)} mm over ${dev.pieces} pieces)`, dev.pieces === 168 && dev.missing === 0 && dev.other === 0 && dev.worst <= 0.01, J({ pieces: dev.pieces, missing: dev.missing, other: dev.other }));
    const mine = dev.nests.filter((n) => n.lotNo.startsWith('16MM'));
    ok(`parts + waste by cause = the plate on all 20 (worst ${identityGap(mine).toFixed(4)} mm²); no plate is stale although two cut pieces have drawings`, identityGap(mine) <= 1 && mine.length === 20 && mine.every((n) => !n.stale && !n.staleInvalid));
    const savedSpo = mine.flatMap((n) => n.pieces).filter((p) => p.cutPlateId === fx.cut.SPO);
    ok('GET …/nesting draws the drawn cut pieces as nested — shapeFrom "nesting file", no holes — also with their drawing on file', savedSpo.length === 8 && savedSpo.every((p) => p.shapeFrom === 'nesting file' && p.rings.holes.length === 0 && Math.abs(p.area - 495000) < 5), J(savedSpo[0]));
    const dxf = await CNC.lotDxf(conn, COMPANY, fx.lineId, lots.find((l) => l.lot_no === '16MM-NECL-PATNA-N11').id).catch((e) => ({ error: e.message }));
    const dxfText = String(dxf.text ?? dxf.content ?? dxf.dxf ?? (Buffer.isBuffer(dxf.buffer) ? dxf.buffer.toString('latin1') : ''));
    // Read back, the export draws the web as it was nested: cambered (many corners), not its 6130 × 2150 rectangle.
    const back = dxf.error ? null : RD.readNestDxf(dxfText, { filename: 'back.dxf' });
    ok('the CNC export of a saved ProNest plate draws the web AS NESTED (cambered, 2275 wide) — not the cut piece\'s rectangle', !!back && back.parts.length === 1 && back.parts[0].rings.outline.length > 20 && Math.abs(Math.min(back.parts[0].bbox.length, back.parts[0].bbox.width) - 2275) < 2, J(dxf.error ?? [Object.keys(dxf), back?.parts.map((p) => [p.bbox, p.rings.outline.length])]));
  }

  /* ───────────── 5. the 10 mm job: thinner than the plate; a DXF in the same request ───────────── */
  section('5. The 10 mm job (1 nest): a 9 mm packing on 10 mm plate — and a DXF in the same request');
  {
    const t = counting(conn);
    const dry = await upload([asReq(J10)], {}, t.db);
    trips.preview10 = t.tally.n;
    const f = dry.files[0];
    const w = dry.warningList.find((x) => x.code === 'PART_THINNER_THAN_PLATE');
    ok('the 9 mm cut piece is found (24 pieces, by size) on the 10 mm plate of the job', dry.files.length === 1 && f.placed === 24 && f.plate.code === fx.plateCode('P10') && f.plate.thickness === 10 && f.placements.every((p) => p.cutPlateId === fx.cut.COV && p.by === 'size'), J([f.placed, f.plate, f.errors]));
    ok('PART_THINNER_THAN_PLATE: a WARNING that needs force, with the two thicknesses and the pieces — not the blocking PART_WRONG_THICKNESS', !!w && w.needsForce === true && w.cutPlateId === fx.cut.COV && w.cutPlateThickness === 9 && w.plateThickness === 10 && w.parts.length === 24 && dry.canSave === true && dry.needsForce === true && dry.problems.length === 0 && f.status === 'warning'
      && new RegExp(`${fx.code('COV')} is 9 mm and is nested on 10 mm plate \\(24 pieces\\)\\. A piece may be cut from the next plate up`).test(w.message), J([w, dry.problems]));
    let saved = await upload([asReq(J10)], { dryRun: false });
    ok('without force it is not saved, and says why', saved.applied === false && /Not saved: a file has a warning — save anyway to keep it\./.test(saved.message), saved.message);
    const t2 = counting(conn);
    saved = await upload([asReq(J10)], { dryRun: false, force: true }, t2.db);
    trips.save10 = t2.tally.n;
    const lot = (await liveLots()).find((l) => l.lot_no === '10MM-NECL-PATNA-N01');
    ok('with force it is: one plate, 24 pieces, stored "tight" and forced with its warning; the cut piece\'s plate line now points at the 10 mm plate', saved.applied === true && saved.forced === true && saved.saved.lots === 1 && saved.saved.pieces === 24 && lot?.check_verdict === 'tight' && !!lot.forced && Number(lot.thickness_mm) === 10 && saved.saved.quantities.find((x) => x.cutPlateId === fx.cut.COV)?.plateCode === fx.plateCode('P10'), J([saved.saved, lot?.check_verdict]));
    const [[thick]] = await conn.query("SELECT v.value_number FROM cf_spec_values v WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id = ? AND v.specification_id = ? AND v.deleted_at IS NULL", [COMPANY, fx.cut.COV, fx.spec.THICKNESS]);
    ok('…and the cut piece keeps its own thickness (9 mm)', Number(thick.value_number) === 9);
    ok(`ROUND TRIPS are the same for a 1-nest job and an 11-nest (20-plate) job: preview ${trips.preview10} / ${trips.preview16}, save ${trips.save10} / ${trips.save16} (the 4-nest job, sent first onto an EMPTY line: ${trips.preview12} / ${trips.save12} — one read fewer, the saved placements)`, trips.preview10 === trips.preview16 && trips.save10 === trips.save16 && trips.preview12 === trips.preview16 - 1 && trips.save12 === trips.save16 - 1, J(trips));

    // A DXF plate and the job in ONE request.
    const plate = { length: 6000, width: 2000 };
    const text = D.makeNestDxf({ plate, parts: [{ shape: D.rectShape(500, 300), x: 100, y: 100, rotationDeg: 0, mirrored: false, label: fx.code('DX') }, { shape: D.rectShape(500, 300), x: 700, y: 100, rotationDeg: 0, mirrored: false, label: fx.code('DX') }], style: 'polyline' });
    const dxfFile = { filename: `${fx.tag}-D1_10mm_6000x2000.dxf`, file: Buffer.from(text, 'latin1').toString('base64') };
    const td = counting(conn);
    await upload([dxfFile], {}, td.db);
    trips.previewDxf = td.tally.n;
    ok(`…and a ProNest job costs no round trip more than a DXF: the preview of one DXF plate is ${trips.previewDxf} too`, trips.previewDxf === trips.preview10, J(trips));
    const both = await upload([dxfFile, asReq(J10)]);
    ok('a DXF and a .nif in the same request: two entries, each its own kind; the DXF is added, the job\'s plate is unchanged; jobs[] holds only the job', both.files.length === 2 && both.files[0].sourceKind === 'dxf' && both.files[0].sourceFile === dxfFile.filename && both.files[0].action === 'add' && both.files[0].jobName === undefined && both.files[0].copies === undefined && both.files[0].placements.every((p) => p.by === 'label' && p.shapeFrom === 'dimensions')
      && both.files[1].sourceKind === 'pronest' && both.files[1].action === 'unchanged' && both.jobs.length === 1 && both.jobs[0].filename === J10.filename && both.canSave === true && both.needsForce === false && /^2 files read \(1 ProNest job: 1 nest, 1 plate\)/.test(both.message), J([both.files.map((x) => [x.sourceKind, x.action]), both.message, both.problems]));
    const savedBoth = await upload([dxfFile, asReq(J10)], { dryRun: false });
    const lots = await liveLots();
    ok('saved together: the DXF plate beside the 25 ProNest plates (source_kind dxf / pronest), three stored files of two kinds', savedBoth.applied === true && lots.length === 26 && lots.filter((l) => l.source_kind === 'dxf').length === 1 && lots.filter((l) => l.source_kind === 'pronest').length === 25 && J((await liveFiles()).map((x) => x.file_kind).sort()) === J(['dxf', 'pronest', 'pronest', 'pronest']), J([lots.length, (await liveFiles()).map((x) => x.file_kind)]));
    const dl = await U.nestFileOf(conn, COMPANY, fx.lineId, lots.find((l) => l.source_kind === 'dxf').id);
    ok('…the DXF still downloads as a DXF', dl.contentType === 'application/dxf' && dl.buffer.toString('latin1') === text);
    // All three jobs and the DXF at once, as a "replace": everything is where it is.
    const all = await upload([asReq(J16), asReq(resaved(J12)), dxfFile, asReq(J10)], { mode: 'replace' });
    ok('all three jobs and the DXF in one request (mode "replace"): 17 entries, 26 plates unchanged, nothing removed', all.files.length === 17 && all.diff.unchanged.length === 26 && all.diff.removed.length === 0 && all.diff.added.length === 0 && all.jobs.length === 3 && J(all.jobs.map((j) => j.plates)) === J([20, 4, 1]), J([all.files.length, all.diff.unchanged.length, all.diff.removed.length, all.problems]));
  }

  /* ───────────── 6. what blocks ───────────── */
  section('6. What still blocks, and how it is said');
  {
    // More than 2 mm thinner: the blocking code, said ONCE for the 24 pieces.
    await conn.query("UPDATE cf_spec_values SET value_number = 6 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, fx.cut.COV, fx.spec.THICKNESS]);
    let out = await upload([asReq(resaved(J10))]);
    const e = out.problemList.filter((x) => x.code === 'PART_WRONG_THICKNESS');
    ok('a cut piece 4 mm thinner than the plate is the blocking PART_WRONG_THICKNESS — said once for the 24 pieces (count, partIds, partName)', e.length === 1 && e[0].count === 24 && e[0].partIds.length === 24 && e[0].partName === '9MM-ED COVER PACK PL-185X1400- 12' && /is 6 mm and .* is 10 mm, so it cannot be cut from it\. The same goes for 23 more pieces of this part on the nest\./.test(e[0].message) && out.canSave === false && !out.warningList.some((x) => x.code === 'PART_THINNER_THAN_PLATE'), J(out.problemList.map((x) => [x.code, x.count, x.message])));
    await conn.query("UPDATE cf_spec_values SET value_number = 9 WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, fx.cut.COV, fx.spec.THICKNESS]);

    // A job the line knows nothing of.
    out = await upload([asReq(J20)]);
    const unknown = out.problemList.filter((x) => x.code === 'PART_UNKNOWN');
    ok(`a job of parts the line does not have (20 mm): 3 entries in error, PART_UNKNOWN once per part and nest (${unknown.length} sentences for 196 pieces), nothing matched, nothing to save`, out.files.length === 3 && out.files.every((f) => f.status === 'error' && f.placed === 0) && unknown.length > 0 && unknown.length <= 27 && sum(unknown, (x) => x.count) === 196 && unknown.every((x) => x.partName && x.partIds.length === x.count) && out.canSave === false && out.jobs[0].matched === 0 && out.jobs[0].status === 'error' && out.jobs[0].placed === 196, J([unknown.length, sum(unknown, (x) => x.count), out.problemList.slice(0, 2).map((x) => x.message)]));
    ok('…each names the part by the shop\'s name and says what was looked for', /part P\d+ \("20MM-.*"\) at \(.*\): Its label "20MM-.*" is not one of the codes, and none of the cut plates is this shape \(.*\)\. It is not one of this line's cut plates\./.test(unknown[0].message), unknown[0].message);

    // Another ProNest, a damaged file, a file that does not agree with itself — beside a good DXF.
    const old = Buffer.from(J10.buffer); old.write('15.1.0.0000', 2 + 'ProNest LT '.length, 'latin1');
    const cut = J10.buffer.subarray(0, 150000);
    const liar = Buffer.from(J10.buffer);
    { const root = NIF._test.parseTree(liar).root; const job = root.kids[0].kids.find((k) => k.id === 1001); const nl = job.kids.find((k) => k.id === 1004).kids.find((k) => k.id === 1007); const first = nl.segs.find(Array.isArray); liar.writeInt32LE(liar.readInt32LE(first[0]) + 1, first[0]); }
    const dxfOk = { filename: `${fx.tag}-D2_10mm_6000x2000.dxf`, file: Buffer.from(D.makeNestDxf({ plate: { length: 6000, width: 2000 }, parts: [{ shape: D.rectShape(500, 300), x: 100, y: 100, rotationDeg: 0, mirrored: false, label: 'NOT-OURS' }], style: 'polyline' }), 'latin1').toString('base64') };
    out = await upload([{ filename: 'old.nif', file: old.toString('base64') }, { filename: 'cut.nif', file: cut.toString('base64') }, { filename: 'liar.nif', file: liar.toString('base64') }, { filename: 'not-a-job.nif', file: Buffer.from('0\nSECTION\n').toString('base64') }, dxfOk]);
    const codes = out.files.map((f) => f.errors[0]?.code);
    ok('four jobs that cannot be read, beside a DXF: one entry each, in words — UNSUPPORTED_VERSION, BAD_FILE, NEST_CHECK_FAILED, BAD_FILE — and the DXF is read all the same', out.files.length === 5 && J(codes.slice(0, 4)) === J(['UNSUPPORTED_VERSION', 'BAD_FILE', 'NEST_CHECK_FAILED', 'BAD_FILE']) && out.files.slice(0, 4).every((f) => f.status === 'error' && f.sourceKind === 'pronest' && f.lotNo === null && f.action === null) && out.files[4].sourceKind === 'dxf' && out.files[4].parts === 1 && out.canSave === false, J(out.files.map((f) => [f.filename, f.errors[0]?.code])));
    ok('the version is named: "old.nif: it was written by ProNest LT 15.1 (15.1.0.0000) — this reads ProNest 2025 LT (16.2). Export the nests as DXF, or send us a sample job so it can be added."', out.files[0].errors[0].message === 'old.nif: it was written by ProNest LT 15.1 (15.1.0.0000) — this reads ProNest 2025 LT (16.2). Export the nests as DXF, or send us a sample job so it can be added.' && out.files[0].errors[0].program === 'ProNest LT' && out.files[0].errors[0].version === '15.1.0.0000' && out.files[0].errors[0].supported === 'ProNest 2025 LT (16.2)', out.files[0].errors[0].message);
    ok('the failed check is named: liar.nif … (check: counts)', out.files[2].errors[0].check === 'counts' && /^liar\.nif: it does not agree with itself, so nothing of it is taken — the nest list: it says it holds 2 nests and holds 1 \(check: counts\)\./.test(out.files[2].errors[0].message), out.files[2].errors[0].message);
    ok('jobs[] says the same of the four: status "error", with the code and the sentence', out.jobs.length === 4 && out.jobs.every((j) => j.status === 'error' && j.error?.code && j.error.message.startsWith(`${j.filename}: `) && j.matched === 0) && out.jobs[0].program === 'ProNest LT' && out.jobs[0].version === '15.1.0.0000', J(out.jobs.map((j) => [j.status, j.error?.code])));
    // Two different files of one job in one request.
    out = await upload([asReq(J12), { ...asReq(resaved(J12)), filename: 'copy of 12mm.nif' }]);
    ok('two files that are the same job in one request: DUPLICATE_NEST, saying the jobs carry the same name', out.problemList.some((x) => x.code === 'DUPLICATE_NEST' && /copy of 12mm\.nif nest 1: it would be plate 12MM-NECL-PATNA-N01, and so would 12MM-NECL-PATNA SPAN1\.nif nest 1 — the two jobs carry the same name \("12MM-NECL-PATNA"\)\. Give one of them its own \(nestNo on the file\)\./.test(x.message)) && out.canSave === false, J(out.problemList.slice(0, 1)));
    out = await upload([{ ...asReq(resaved(J12)), filename: 'span 2.nif', nestNo: `${fx.tag}-S2` }]);
    ok('…and nestNo on the file gives the second its own lot numbers (<nestNo>-N01 …)', out.files.length === 4 && J(out.files.map((f) => f.lotNo)) === J([1, 2, 3, 4].map((n) => `${fx.tag}-S2-N0${n}`)) && out.files.every((f) => f.action === 'add') && out.jobs[0].lotPrefix === `${fx.tag}-S2` && out.warningList.some((w) => w.code === 'OVER_COVERAGE'), J([out.files.map((f) => f.lotNo), out.warningList.map((w) => w.code)]));
  }

  /* ───────────── 7. choices, and taking a plate off ───────────── */
  section('7. Choosing by the shop\'s part name; taking one plate of a ×4 nest off');
  {
    // The long webs were shared out. Say, once for the job, which cut piece "WEB PL2" is.
    const again = resaved(J16);
    const out = await upload([asReq(again)], { choices: { [J16.filename]: { '16MM-WEB PL2-2128X11944- 4': fx.cut.WEBB2 } } });
    const n1 = out.files[0];
    ok('choices keyed by the job\'s file and the PART NAME settle every piece of that part: nest 1 (WEB PL2, ×4) is the cut piece chosen, by "choice", on all four plates', n1.placements.length === 1 && n1.placements[0].by === 'choice' && n1.placements[0].cutPlateId === fx.cut.WEBB2 && n1.copies.every((k) => J(sfxCounts(k.counts)) === J({ WEBB2: 1 })) && out.problems.length === 0, J([n1.placements[0], n1.copies.map((k) => sfxCounts(k.counts)), out.problems]));
    ok('…the other two long webs are still shared out by quantity, into what is left (2 + 6)', out.coverage.find((x) => x.cutPlateId === fx.cut.WEBB1).nested === 6 && out.coverage.find((x) => x.cutPlateId === fx.cut.WEBB2).nested === 6, J(out.coverage.filter((x) => [fx.cut.WEBB1, fx.cut.WEBB2].includes(x.cutPlateId))));
    // (2026-10-14) Any cut piece of the line may be chosen — also one the ladder would never have offered.
    const odd = await upload([asReq(again)], { choices: { [J16.filename]: { '16MM-WEB PL2-2128X11944- 4': fx.cut.CG } } });
    ok('a cut piece the part "cannot be" may be chosen all the same: taken, by "choice", and the answer says how the sizes differ', !odd.problemList.some((x) => x.code === 'CHOICE_INVALID') && odd.files[0].placements[0].by === 'choice' && odd.files[0].placements[0].chosen === true && odd.files[0].placements[0].cutPlateId === fx.cut.CG && J(odd.files[0].placements[0].outlineDiffers?.cutPiece) === J([490, 350]), J([odd.problems, odd.files[0].placements[0]]));
    const bad = await upload([asReq(again)], { choices: { [J16.filename]: { '16MM-WEB PL2-2128X11944- 4': 'NO-SUCH-CUT-PIECE' } } });
    ok('a choice that names no cut piece of the line → CHOICE_INVALID, once for the nest', bad.problemList.filter((x) => x.code === 'CHOICE_INVALID').length === 1 && /"NO-SUCH-CUT-PIECE" was chosen for it, but that is not one of this line's cut pieces\./.test(bad.problemList.find((x) => x.code === 'CHOICE_INVALID').message), J(bad.problems));

    const lots = await liveLots();
    const one = lots.find((l) => l.lot_no === '16MM-NECL-PATNA-N02-3');
    const gone = await U.deleteNestLot(conn, c, fx.lineId, one.id);
    const after = await liveLots();
    const still = await U.nestFileOf(conn, COMPANY, fx.lineId, after.find((l) => l.lot_no === '16MM-NECL-PATNA-N02-4').id);
    ok('one plate of a ×4 nest taken off: 25 plates left, its web back in leftOver — and the job\'s file is STILL there for the other 19 plates', gone.applied === true && gone.removed.lotNo === '16MM-NECL-PATNA-N02-3' && after.length === 25 && gone.leftOver.some((x) => [fx.cut.WEBB1, fx.cut.WEBB2].includes(x.cutPlateId) && x.qty === 1) && still.buffer.equals(J16.buffer) && (await liveFiles()).length === 4, J([after.length, (await liveFiles()).length]));
    const back = await upload([asReq(J16)]);
    ok('uploading the job again puts that one plate back: 19 unchanged, 1 added', back.diff.unchanged.length === 19 && back.diff.added.length === 1 && back.diff.added[0].lotNo === '16MM-NECL-PATNA-N02-3' && back.files[1].copies.map((k) => k.action).join() === 'unchanged,unchanged,add,unchanged' && back.canSave === true, J([back.diff.unchanged.length, back.diff.added.map((a) => a.lotNo), back.files[1].copies.map((k) => k.action)]));
    // Every plate of the 12 mm job off: its file goes with the last one.
    for (const l of after.filter((x) => x.lot_no.startsWith('12MM'))) await U.deleteNestLot(conn, c, fx.lineId, l.id);
    ok('all four plates of the 12 mm job taken off: its stored file goes with the last of them', (await liveFiles()).filter((x) => x.file_name === J12.filename).length === 0 && (await liveLots()).length === 21);
  }

  /* ───────────── 8. the parts table, and choosing the cut piece (2026-10-14) ───────────── */
  section('8. The 25 mm job (5 nests, 116 pieces) — every part says its match; any match can be changed; an unmatched part is given its cut piece');
  {
    // Its own cut pieces: the flanges at their FINISHED length (the shop nests them 15 mm over), one flange
    // at the nested size, a 23 mm twin, and NOTHING for the bottom inner splice plate — only a near miss.
    await fx.addPlate('P25', [25, 12000, 2500, 'A']);
    await fx.addParts({
      TF: [25, 6120, 500, 8, 'P25', 'ZT-F'],                  // "TOP FL1-500X6135": 15 mm over
      TFX: [25, 6135, 500, 8, 'P25', 'ZT-FX'],                // the same flange at the nested size
      BF: [25, 6120, 750, 8, 'P25', 'ZB-F'],                  // "BTM FL1-750X6135": matched only with the allowance
      TF23: [23, 6135, 500, 1, 'P25', 'ZT-F23'],              // 2 mm thinner than the plate
      SPTO: [25, 2290, 700, 8, 'P25', 'ZS-TO'],
      SPTI: [25, 2290, 275, 20, 'P25', 'ZS-TI'],
      SPBO: [25, 1770, 950, 8, 'P25', 'ZS-BO'],
      EDS: [25, 2150, 240, 49, 'P25', 'ZE-DS'],
      SPBX: [25, 1800, 400, 16, 'P25', 'ZS-BX'],              // NOT "BTM INNER PL-400x1770": 30 mm longer
    });
    const TOP = '25MM-EG1-IG1 TOP FL1-500X6135- 8'; const BTM = '25MM-EG1-IG1 BTM FL1-750X6135- 8'; const INNER = '25MM-SP2 BTM INNER PL-400x1770- 16';
    const rowOf = (out, name) => out.jobs[0].partRows.find((r) => r.partName === name);
    const all = Object.keys(fx.cut).length;

    const t = counting(conn);
    const dry = await upload([asReq(J25)], {}, t.db);
    trips.preview25 = t.tally.n;
    const job = dry.jobs[0];
    ok('jobs[].partRows: one row per part NAME of the job (7), however many nests hold it — and jobs[].parts is still the number', job.partRows.length === 7 && job.parts === 7 && job.partRows.every((r) => r.key === r.partName && r.candidates.length === all && r.pieces > 0) && sum(job.partRows, (r) => r.pieces) === 116, J(job.partRows.map((r) => [r.partName, r.pieces, r.status, r.candidates.length])));
    ok('every placement points at its row (partKey = the part name)', dry.files.every((f) => f.placements.every((p) => p.partKey === p.partName && !!rowOf(dry, p.partKey))));
    const top = rowOf(dry, TOP); const btm = rowOf(dry, BTM); const inner = rowOf(dry, INNER);
    ok('a part matched outright (two cut pieces are its size — the 25 mm one, by its steel): status "matched", what it is and by which rung, its drawn size and the size in its name, the nests it is on', top.status === 'matched' && top.matched.cutPlateId === fx.cut.TFX && top.matched.by === 'steel' && top.matched.pieces === 8 && top.matched.allowanceMm === undefined && J(top.drawn) === J([6135, 500]) && J(top.nameSize) === J([6135, 500]) && J(top.nests) === J([1, 3, 5]) && top.open === 0 && top.pieces === 8, J({ ...top, candidates: 0 }));
    console.log(`    candidates for "${TOP}" (the first five of ${top.candidates.length}):`);
    for (const k of top.candidates.slice(0, 5)) console.log(`      ${String(k.fit).padStart(9)}  ${fx.sfxOfCut(k.cutPlateId).padEnd(5)} ${k.thickness} × ${k.width} × ${k.length}  needs ${k.needed}  — ${k.why}`);
    const sfxOrder = top.candidates.map((k) => fx.sfxOfCut(k.cutPlateId));
    ok('its candidates: the same size first, then the cutting allowance, then the nearest by size', J(sfxOrder.slice(0, 3)) === J(['TFX', 'TF', 'BF']) && top.candidates[0].why === 'same size' && top.candidates[1].why === '15 mm longer, same width' && top.candidates[2].why === '15 mm longer, 250 mm narrower' && top.candidates[0].fit === 1000000 && top.candidates[1].fit === 2000015 && top.candidates[2].fit === 3000265, J(top.candidates.slice(0, 4)));
    const sortedAll = (r) => r.candidates.every((k, i) => i === 0 || r.candidates[i - 1].fit <= k.fit);
    const onceEach = (r) => new Set(r.candidates.map((k) => k.cutPlateId)).size === all && Object.values(fx.cut).every((id) => r.candidates.some((k) => k.cutPlateId === Number(id)));
    ok('every row lists EVERY cut piece of the line once, sorted by fit (smaller is better)', job.partRows.every((r) => sortedAll(r) && onceEach(r)));
    const cls = (k) => (k.thickness === 25 ? 0 : k.thickness === 23 ? 1 : 2);
    ok('the plate\'s thickness, then up to 2 mm thinner, then the others — an impossible one is never above a possible one, and says its thickness', job.partRows.every((r) => r.candidates.every((k, i) => (i === 0 || cls(r.candidates[i - 1]) <= cls(k)) && k.possible === (cls(k) < 2) && (cls(k) < 2 || k.why === `other thickness (${k.thickness} mm)`)))
      && top.candidates.find((k) => k.cutPlateId === fx.cut.TF23).why === 'same size · 2 mm thinner than the plate' && top.candidates.find((k) => k.cutPlateId === fx.cut.WEBA).why === 'other thickness (16 mm)', J(top.candidates.filter((k) => cls(k) > 0).slice(0, 3)));
    ok('a candidate says code, name, thickness, length ≥ width, grade and how many the line needs', (() => { const k = top.candidates[1]; return k.code === fx.code('TF') && !!k.name && k.thickness === 25 && k.length === 6120 && k.width === 500 && k.grade === fx.GA && k.needed === 8; })(), J(top.candidates[1]));
    ok('THE ALLOWANCE IS CALLED OUT: the bottom flange is status "allowance", matched with allowanceMm 15 through the size in its name', btm.status === 'allowance' && btm.matched.cutPlateId === fx.cut.BF && btm.matched.allowanceMm === 15 && btm.matched.by === 'name size' && J(btm.matched.outlineDiffers) === J({ drawn: [6135, 750], cutPiece: [6120, 750] }) && btm.candidates[0].cutPlateId === fx.cut.BF && btm.candidates[0].why === '15 mm longer, same width', J({ ...btm, candidates: btm.candidates.slice(0, 2) }));
    const others = Object.entries(job.matchedBy).filter(([k]) => k !== 'allowance').reduce((a, [, v]) => a + v, 0);
    ok(`…and matchedBy.allowance counts its 8 pieces as an "of which": ${J(job.matchedBy)} — matched (${job.matched}) is still the sum of the other keys`, job.matchedBy.allowance === 8 && job.matchedBy['name size'] === 8 && others === job.matched && job.matched === 100, J([job.matchedBy, job.matched]));
    ok('a part that matched nothing: status "unmatched", matched null, every piece open — PART_UNKNOWN points at the row, and the nearest cut piece leads its list', inner.status === 'unmatched' && inner.matched === null && inner.open === 16 && inner.pieces === 16 && dry.canSave === false && dry.problemList.filter((x) => x.code === 'PART_UNKNOWN').every((x) => x.partKey === INNER) && dry.problemList.some((x) => x.code === 'PART_UNKNOWN')
      && inner.candidates[0].cutPlateId === fx.cut.SPBX && inner.candidates[0].why === 'same width, 30 mm shorter', J([{ ...inner, candidates: inner.candidates.slice(0, 2) }, dry.problems.slice(0, 2)]));
    ok('rows come worst first: unmatched, then the allowance, then the matched', J(job.partRows.map((r) => r.status)) === J(['unmatched', 'allowance', 'matched', 'matched', 'matched', 'matched', 'matched']), J(job.partRows.map((r) => r.status)));

    // ---- choosing for the part that matched nothing --------------------------------
    const pick = { [J25.filename]: { [INNER]: fx.cut.SPBX } };
    const t2 = counting(conn);
    const fixed = await upload([asReq(J25)], { choices: pick }, t2.db);
    trips.preview25chosen = t2.tally.n;
    const innerPl = fixed.files.flatMap((f) => f.placements).filter((p) => p.partName === INNER);
    ok('A CHOICE MAPS AN UNMATCHED PART: one answer by the part name covers all 16 pieces on 4 nests — by "choice", chosen, laid where they are drawn, the nested outline stored', innerPl.length === 16 && innerPl.every((p) => p.by === 'choice' && p.chosen === true && p.cutPlateId === fx.cut.SPBX && p.shapeFrom === 'nesting file' && J(p.outlineDiffers) === J({ drawn: [1770, 400], cutPiece: [1800, 400] }) && p.allowanceMm === undefined && Math.abs(Math.max(p.length, p.width) - 1770) < 0.1)
      && !fixed.problemList.some((x) => x.code === 'PART_UNKNOWN') && fixed.problems.length === 0 && fixed.canSave === true, J([fixed.problems, innerPl[0] && { ...innerPl[0], rings: 0 }]));
    ok('…its row now reads "chosen", and a note says how the sizes differ and what is stored', rowOf(fixed, INNER).status === 'chosen' && rowOf(fixed, INNER).matched.cutPlateId === fx.cut.SPBX && rowOf(fixed, INNER).matched.by === 'choice' && rowOf(fixed, INNER).open === 0 && fixed.jobs[0].matchedBy.choice === 16 && fixed.jobs[0].matched === 116
      && fixed.files.some((f) => f.notes.some((s) => s.includes(`${fx.code('SPBX')} was chosen for "${INNER}", which is another size: it is drawn 1770 × 400, the cut piece is 1800 × 400. The nested outline is what is cut`))), J([rowOf(fixed, INNER).status, fixed.jobs[0].matchedBy, fixed.files.flatMap((f) => f.notes).filter((s) => /was chosen/.test(s))[0]]));
    ok(`…and the choice costs no round trip: the preview is ${trips.preview25chosen} with it, ${trips.preview25} without — what every other job costs (${trips.preview10})`, trips.preview25chosen === trips.preview25 && trips.preview25 === trips.preview10, J(trips));

    // ---- changing what the ladder matched ------------------------------------------
    let out = await upload([asReq(J25)], { choices: { [J25.filename]: { ...pick[J25.filename], [TOP]: fx.cut.TF } } });
    let topPl = out.files.flatMap((f) => f.placements).filter((p) => p.partName === TOP);
    ok('A CHOICE OVERRIDES A LADDER MATCH: the top flange, matched by size to the 6135 one, is the 6120 one because the user said so — with the allowance said', topPl.length === 8 && topPl.every((p) => p.by === 'choice' && p.chosen === true && p.cutPlateId === fx.cut.TF && p.allowanceMm === 15) && rowOf(out, TOP).status === 'chosen' && rowOf(out, TOP).matched.allowanceMm === 15 && out.problems.length === 0
      && out.coverage.find((x) => x.cutPlateId === fx.cut.TF).nested === 8 && out.coverage.find((x) => x.cutPlateId === fx.cut.TFX).nested === 0, J([out.problems, topPl[0] && { ...topPl[0], rings: 0 }]));
    ok('…a piece the user chose is under "choice", never in the allowance count (still the 8 of the bottom flange)', out.jobs[0].matchedBy.allowance === 8 && out.jobs[0].matchedBy.choice === 24, J(out.jobs[0].matchedBy));
    out = await upload([asReq(J25)], { choices: { [J25.filename]: { ...pick[J25.filename], [TOP]: fx.cut.TF }, [`${J25.filename} nest 1`]: { P1: fx.cut.TFX } } });
    topPl = out.files.flatMap((f) => f.placements.map((p) => ({ ...p, nest: f.jobNestNo }))).filter((p) => p.partName === TOP);
    ok('A PART ID BEATS ITS NAME: nest 1\'s P1 is the cut piece chosen for it, the other 7 pieces the one chosen for the name — the row says both', topPl.filter((p) => p.cutPlateId === fx.cut.TFX).length === 1 && topPl.find((p) => p.cutPlateId === fx.cut.TFX).partId === 'P1' && topPl.find((p) => p.cutPlateId === fx.cut.TFX).nest === 1 && topPl.filter((p) => p.cutPlateId === fx.cut.TF).length === 7 && topPl.every((p) => p.by === 'choice')
      && J(rowOf(out, TOP).matchedTo.map((x) => [fx.sfxOfCut(x.cutPlateId), x.pieces])) === J([['TF', 7], ['TFX', 1]]) && rowOf(out, TOP).matched.cutPlateId === fx.cut.TF, J(rowOf(out, TOP).matchedTo));
    out = await upload([asReq(J25)], { choices: { [J25.filename.replace(/\.nif$/, '')]: { [INNER]: fx.code('SPBX') } } });
    ok('the old key forms still work: the job named without ".nif", the cut piece by its code', out.problems.length === 0 && rowOf(out, INNER).status === 'chosen', J(out.problems));

    // ---- what is refused, and what still blocks ------------------------------------
    out = await upload([asReq(J25)], { choices: { [J25.filename]: { [INNER]: 'NOT-A-CUT-PIECE' } } });
    let bad = out.problemList.filter((x) => x.code === 'CHOICE_INVALID');
    ok('CHOICE_INVALID — a value that is no cut piece of the line: said once per nest the part is on, the part left unmatched', bad.length === 4 && bad.every((x) => x.partName === INNER && x.partKey === INNER && /"NOT-A-CUT-PIECE" was chosen for it, but that is not one of this line's cut pieces\./.test(x.message)) && rowOf(out, INNER).status === 'unmatched' && out.canSave === false && !out.problemList.some((x) => x.code === 'PART_UNKNOWN'), J(out.problems.slice(0, 2)));
    out = await upload([asReq(J25)], { choices: { [J25.filename]: { ...pick[J25.filename], 'NO SUCH PART': fx.cut.TF } } });
    bad = out.problemList.filter((x) => x.code === 'CHOICE_INVALID');
    ok('CHOICE_INVALID — a part name that is not a part of that job: said once, for the job', bad.length === 1 && J(bad[0].parts) === J(['NO SUCH PART']) && bad[0].message === `${J25.filename}: a cut piece was chosen for "NO SUCH PART", but that is not a part of this job. Nothing was done with it — take the choice away, or choose again.` && out.canSave === false, J(out.problems));
    out = await upload([asReq(J25)], { choices: { [`${J25.filename} nest 2`]: { P99: fx.cut.TF }, ...pick } });
    bad = out.problemList.filter((x) => x.code === 'CHOICE_INVALID');
    ok('…and a part id the nest does not have: said once, for the nest', bad.length === 1 && /nest 2: a cut piece was chosen for "P99", but that is not a part of this nest\./.test(bad[0].message), J(out.problems));
    out = await upload([asReq(J25)], { choices: { [J25.filename]: { [INNER]: fx.cut.WEBA } } });
    ok('A CHOSEN CUT PIECE OF ANOTHER THICKNESS STILL BLOCKS: PART_WRONG_THICKNESS, in words', out.canSave === false && out.problemList.some((x) => x.code === 'PART_WRONG_THICKNESS' && x.message.includes(`${fx.code('WEBA')} is 16 mm and ${fx.plateCode('P25')} is 25 mm, so it cannot be cut from it.`)) && rowOf(out, INNER).status === 'chosen', J(out.problems.slice(0, 2)));
    out = await upload([asReq(J25)], { choices: { [J25.filename]: { ...pick[J25.filename] }, [`${J25.filename} nest 1`]: { P1: fx.cut.TF23 } } });
    ok('…one 2 mm thinner is the warning it always was (PART_THINNER_THAN_PLATE), not a blocker', out.problems.length === 0 && out.warningList.some((w) => w.code === 'PART_THINNER_THAN_PLATE' && w.cutPlateId === fx.cut.TF23) && out.needsForce === true, J([out.problems, out.warnings]));

    // ---- saved with the choice ------------------------------------------------------
    const lotsBefore = (await liveLots()).length;
    const t3 = counting(conn);
    const saved = await upload([asReq(J25)], { choices: pick, dryRun: false, force: fixed.needsForce }, t3.db);
    trips.save25 = t3.tally.n;
    const [rows] = await conn.query("SELECT p.cut_plate_id, p.rings_json FROM cf_nest_placements p JOIN cf_plate_lots l ON l.id = p.plate_lot_id AND l.company_id = p.company_id WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL AND l.lot_no LIKE '25MM-%' AND p.deleted_at IS NULL", [COMPANY, fx.lineId]);
    ok(`SAVED with the choice: 5 plates, 116 pieces — in ${trips.save25} round trips, what the 11-nest job cost (${trips.save16})`, saved.applied === true && saved.saved.lots === 5 && saved.saved.pieces === 116 && (await liveLots()).length === lotsBefore + 5 && trips.save25 === trips.save16, J([saved.message, trips]));
    ok('…the 16 chosen pieces are stored as that cut piece, with the nested outline', rows.filter((r) => Number(r.cut_plate_id) === Number(fx.cut.SPBX)).length === 16 && rows.filter((r) => Number(r.cut_plate_id) === Number(fx.cut.SPBX)).every((r) => /"asCut":\s*true/.test(typeof r.rings_json === 'string' ? r.rings_json : J(r.rings_json))), J(rows.slice(0, 1)));
    const view = await N.getNesting(conn, COMPANY, fx.lineId);
    const kept = view.groups.flatMap((g) => g.nests).filter((x) => x.lotNo.startsWith('25MM-')).flatMap((x) => x.pieces).filter((p) => p.cutPlateId === fx.cut.SPBX);
    ok('…and GET …/nesting shows them at the size they are nested (1770 × 400), not the cut piece\'s 1800', kept.length === 16 && kept.every((p) => Math.abs(Math.max(p.length, p.width) - 1770) < 0.1 && p.shapeFrom === 'nesting file'), J(kept.slice(0, 1).map((p) => [p.length, p.width, p.shapeFrom])));
  }
} catch (err) {
  failed += 1;
  fails.push(`ERROR ${err?.message}`);
  console.error('\nERROR', err);
} finally {
  await R.settleRuns().catch(() => {});
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}

section('Nothing survived the rollback');
const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
ok('every cf_ table is back to the count it started at', drift.length === 0, drift.map((d) => `${d.name} ${before.find((b) => b.name === d.name)?.n}->${d.n}`).join(', '));

console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  failed: ${fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
